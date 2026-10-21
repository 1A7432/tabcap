# 证据包规范 v0（作者 2026-10-21 签收；之后的改动按 AGENTS.md 先提案）

2026-10-15。对应 `03` §5 `bundle` 模块与 §10 第 1 条。本文定义**录制器写什么、分析命令读什么、怎么和 HAR 互转**。先定格式再写代码；格式一旦有样例文件，样例就是测试的 oracle。

标注：【实测】跑过；【推断】间接推出；【待验】没验证；**P1** 阶段 1 实现；**P2** 阶段 2 才实现，但 v0 先把 kind 占住，避免以后改格式。

工具名已定为 `tabcap`（10-15，`03` §8）；命令行示例起初用占位符 `bbl`，已全部换成 `tabcap`。格式标识用中性的 `evidence-bundle/0`，不随工具名变。

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
  decoded.jsonl                   可选：`bundle decode` 追加的解码视图旁路文件（只追加，§28）；读者叠加到请求事件上
  exports/                        导出产物（HAR、脱敏副本、侦查档案 dossier.json / dossier.md、响应形状 shape.json（§32）、超出输出预算的回答 <command>-<seq>.json，§24）；不参与分析
```

- 包完整的判定：`manifest.json` 有 `finished`。没有就是录制中或异常中断，分析命令照样读，但在输出里标明（警告 `bundle is not finished: …`，文本报告里 `(unfinished)`）。
- `blobs/` 写法：先写临时文件，`fsync`，再 `rename` 到哈希名；同内容只存一份。
- `raw/` 默认开（lab 阶段要靠它查录制器漏没漏），以后再议默认关。（已定 a）

### 2.1 CLI 回答：信封与公共字段名（0.7-C，10-17 主循环定需求；表与改名按实现定案，作者 2026-10-21 批量签收）

每条命令打印一个 JSON 信封：成功 `{ok:true, data}`，失败 `{ok:false, error:{code, message, next}}`；`data` 超过输出预算时换成 `{summary, file, bytes, truncated:true}`（§24）。下表是**回答里**（`data`）的公共字段名；包内落盘格式（§3–§7 的事件、manifest、`decoded.jsonl`）不受它约束，保留原名（例如事件与 blob 引用里的 `size`、信封的 `ts`）。外部格式（HAR 1.2 的 `bodySize` / `startedDateTime` / `time`，CDP 的 `requestId` / `timestamp`）也照原样。

| 名字 | 用于 | 不用 |
|---|---|---|
| `bytes` | 字节数（正文、postData、帧载荷、导出文件） | `size`、`length`（`length` 只用于元素个数） |
| `id` | 一行**就是**这个请求时的请求 id `r-N`（WebSocket 帧 `r-N:M`） | `requestId`、`ref`（指向别的请求的字段仍叫 `request`，如 `edges[].from.request`） |
| `cmd` | 命令 id `c-N` | `commandId` |
| `tab` | 标签 id `t-N` | `tabId` |
| `at` | epoch 毫秒的时刻 | — |
| `…Ms` | 时长（毫秒），如 `waitedMs`、`timeoutMs`、`plannedMs`、`totalMs` | 无后缀的时长 |
| `url` | URL | — |
| `count` / `total` | 计数 / 总数 | — |
| `bundles: [{short, dir}]` | 比较或引用多个包的回答（`analyze diff`、`analyze schema-diff`）；`short` 是包目录的 basename（同名的第二个起加 `~2`、`~3`），行里用 `bundle: "<short>"` 标出所属包，`id` 仍是该包里的 `r-N`、不改写 | 包序号 |

0.7-C 按此表改过的回答字段（落盘格式未动）：`net list` 行与 `--kind ws` 行、`net body`（预览与 `--pretty`）、`net wait`、`net show`（`request.postData`、`response.body`、帧与 `payload`）的 `size` → `bytes`；`analyze find` 的 `hints.suspectEncrypted[].size` → `bytes`；`replay check` 的 `diffs.body.recordedSize` / `gotSize` → `recordedBytes` / `gotBytes`；`net grep` 的行与 `skipped[]` 的 `request` → `id`；`analyze chain` 的 `steps[].request` → `id`（`todo[]` / `inputs[]` 是某个请求的输入，仍叫 `request`）；`analyze diff` 的 `groups[].requests[]` 从 `{bundle:<序号>, ref}` 改为 `{bundle:"<short>", id}`，`bundles[]` 多 `short`；`analyze schema-diff` 多 `bundles`；`click --trusted` / `hover` 的 `trajectory.ms` → `plannedMs`（与同一对象里的 `actualMs` 对齐）；`net show` 的 `timing.total` → `timing.totalMs`。

留着没改的（NOTES 0.7-C 有清单）：落盘或直接透传落盘字段的（`ts`、blob 引用与事件里的 `size`、`net show` 的 `timing.start` / `end` 单调时钟）；与 `at` 已有别的含义冲突的（`console list` 的 `at` 是 `url:line:col`，`click` 的 `at` 是坐标，`net body --at` 是行列），所以 `console list` / ws 行的墙钟时刻仍叫 `ts`，`since` / `startedAt` / `savedAt` / `generatedAt` 等具名时刻也未改；`analyze find` 的 `hits[].ref`（console 命中时为 null，`where` / `find` 文档都以 `ref` 描述）；`wait` 块的 `ms`（字段名本身就是 `ms`；`fetch` 的 `timing.ms` 在 0.7-E 改成了 `timing.totalMs`，§36）；`session list` 的 `tabs`（数组）与 `status` 的 `tabs`（个数）。

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

**`cmd`**：两条（§14 裁决）：开始 `{id:"c-<seq>", phase:"start", actor:"ai", argv:[...]|null, input:{...}}`，结束 `{phase:"end", ref:"c-<seq>", ok:bool, error, durationMs, outputSummary}`。每次 CLI / skill / MCP 调用一对，是「AI 操作窗口」的依据；窗口内事件的 `cmd` 字段引用开始那条的 id。`outputSummary` 是结果的小摘要（顶层标量）；命令有回执时带 `outputSummary.receipt`（短字符串对象，`09` §13.3 草案，不另立 kind）：0.4-J 起 `recon` 写 `{dossier:"exports/dossier.json"}`。0.6-A 起 `fetch` 的结束事件总带 `outputSummary.requests`：该命令发出的全部 `r-N`（按 `fetchId` 归属，含重定向跳与预检；命令失败、被停手规则拦下时也写），正文、`bodyBase64` 不进摘要；被停手的错误不带 `result`（响应在 `request` 事件里）。

**`console`**（0.2 新增）：`{tab, level:"log"|"info"|"warn"|"error"|"debug", source:"console"|"exception"|"network"|"security"|"other", text, args:[...截断后的参数摘要], url, line, col, stack:string|null}`。来自 `Runtime.consoleAPICalled`、`Runtime.exceptionThrown`、`Log.entryAdded`；单条 `text` 超过 4 KB 截断并标 `truncated:true`。站点在签名校验失败、接口异常时常把线索吐在这里，`find` 也搜它。

**`action`**：`{tab, op, target, value, phase:"done"|"failed", error, shots:{before:"sha256:…", after:"sha256:…"}, nav, trusted:bool}`。
- `op`：`click` / `fill` / `key` / `select` / `scroll` / `navigate` / `upload` / `dialog` / `evaluate`；0.7.1-A 加 `input`（人的一次原始输入，只有种类 `event` 与时刻 `at`，§37）。
- `target`：`{ref, role, name, selector, rect:[x,y,w,h], frame}`，有什么填什么；`selector` 只是给人看的定位提示，不是重放契约。
- `frame`（0.4-I）：动作所在帧的帧路径（`f2/f1`，见 §6 快照 ref），根文档不写；`ref` 保留原样（`f2/f1/e7`）。录制器目前还不写 `action` 事件，现行落点见 §23。
- `value`：`fill`/`key` 的文本；`type=password`、`autocomplete` 含 `cc-`/`one-time-code` 的字段一律写 `"<masked>"`，录制时就不落盘。经 §8.1 的 secret 引用填入的，写 `"<secret:<name>>"`。
- 人的操作（`actor:"human"`）：探路由 AI 做之后，人只在验证码、二次验证、需要人点的时刻介入。这些时刻的人工操作由隔离世界里的被动监听器记（只记 pointer click、input 的 change/失焦提交、Enter/Tab），不改页面行为；**P2 实现**，P1 只记介入前后的截图和 `nav`。P2 做时只在 `handoff` 进入「人在操作」状态期间武装监听器，其余时间不挂。（已定 b）
  0.7.1-A（§37）先做了这一条的一部分，并改了「其余时间不挂」：为了**识别**人接管，`direct` 模式下每个 owned 标签一直挂着一个被动监听器，但它只报 `pointerdown` / `keydown` / `wheel` / `touchstart` 的种类与时刻，不报目标、坐标、键值。等人期间这些输入写成 `action {op:"input", event, at, target:null, value:null, …}`、`actor:"human"`、`cmd:null`；目标元素、`fill` 的提交值、Enter / Tab 的语义仍是 P2（未做）。

**`screenshot`**：`{tab, blob:"sha256:…", format:"png"|"jpeg", width, height, scale, reason:"nav"|"action"|"manual"|"interval"|"handoff", nav}`。

**`state`**：`{tab, what:"cookies"|"localStorage"|"sessionStorage", origin, blob:"sha256:…", count, reason:"session-start"|"nav"|"session-stop"|"manual"}`。
内容：cookies 用 CDP `Network.getCookies` 的原样数组；storage 用 `[[key,value],…]`。P1 只做 cookies、只在 session 起止和每次 `navigation` 类 nav 时取。

**`finding`**：`{actor:"ai"|"human", tool:"find"|"diff"|"deps"|"trace"|"where"|"wire"|"manual", grade:"实测"|"推断"|"待验"|"人确认", claim, evidence:[{request:"r-57", path:"$.items[3].title"}|{ws:"r-12", frame:seq}|{blob}], input, output}`。
分析命令默认不写入；加 `--save` 才追加；`grade` 只有人能标 `人确认`（P2 的 `confirm` 事件会生成它）。

`tool:"wire"`（0.4-W2）：`tabcap wire probe` 在该会话**正在录制**时写入，每个结论不是 `same` 的层（`tls` / `h2` / `headers`）一条，grade `实测`（本机 echo 上实际收到的字节）。四份文档先存成 blob（`evidence` 是它们的 `{blob}`）：`browserReport`（基准里的一次浏览器导航的每连接报告）、`clientReport`（生成的客户端那次 GET 的报告）、`check`（组件 `check` 的 JSON）、`diff`（组件 `diff --json` 的 JSON）；报告形状见 `11` §3.2。`input` = `{browser:{version, flagsHash, profile, cached}, client:{library, version}, layer}`，`output` = `{verdict:"differs"|"missing", fields:[字段路径]}`。`claim` 只说哪层、哪些字段不同（「在本机 echo 上测得」），不说原因、不给改法。命令自己的输出是 `tabcap-wire/0`：`{schema, browser:{version, flagsHash, profile, cached}, client:{library, version}, layers:[{layer, verdict:"same"|"differs"|"missing", fields:[{field, browser, client}]}], checks:[{code, status:"red"|"warn"|"info", message}], labels:[{label:"psk", browser, client}], note, saved?:{bundle, seqs, blobs}}`，`note` 固定为 "differences are measured on a local echo; they say which layer differs, not why a site refused anything"。

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

- **`handoff`**：`{state:"waiting"|"human-active"|"resumed", reason, question, timeoutMs, answerRef}`。实际写出的（0.3-A 起）：`waiting` 与 `resumed`（`human-active` 仍只占位；「人在操作」是守护进程内的状态，见 §37）；`reason` 为 `verify-page`（guard 认出的验证页）、`stop-rule`（0.6-I 站点停手规则）、`human-takeover`（0.7.1-A：tabcap 在 AI 的标签上看到人的可信输入，`input:{event, at}`、`request:null`、`screenshot:null`，§37）。`resumed` 的 `by`：`human`（`handoff continue`）、`plugin:<名>`（challenge 处理程序回答）、`guard-resume`（`guard resume --site` 一并结束 `stop-rule` 的等待）、`condition`（0.7.5-B：`handoff wait --until-*` 的条件满足，多一个 `condition:{kind, value}`，§39）。
- **`confirm`**：`{question, options, answer, by:"human", refs, producesFinding:"<seq>"}`。
- **`guard`**：`{event:"budget"|"breaker"|"probe", site, account, detail}`。0.4-D 起 `budget` 与 `breaker` 实际写出（`probe` 仍只占位）：配置了每小时请求预算（`config.json` `pool.budget.requestsPerHour`）时，账号用满预算写 `budget`（`detail.rule:"requests-per-hour"`）；账号 24 h 内第 2 次登录失败转 `needs-human` 时写 `budget`（`detail.rule:"failed-logins"`）；熔断时写 `breaker`，会话绑了账号时 `detail.coolUntil` 是冷却结束时刻。0.6-A 起 `breaker` 多一种原因：`tabcap fetch` 的停手规则命中，写 `{event:"breaker", site, account, reason:"fetch-stop", rule, request:"r-N", detail:{reason:"fetch-stop", rule, detail, request, fetchId, url, status}}`（不进 `waiting`、不冷却账号）；`tabcap guard resume --site` 或该会话的 `handoff continue` 解除时写 `{event:"resume", site, account:null, reason:"fetch-stop", rule, request, by:"guard-resume"|"handoff-continue", detail:{…同上三项}}`（§26）。0.6-I 起还有 `reason:"stop-rule"`：站点停手规则（`config.json` `sites.<名>.guard`）命中，写 `{event:"breaker", site, account, reason:"stop-rule", rule, request:"r-N", detail:{reason:"stop-rule", rule, detail, request, url, status[, fetchId]}}`，并跟一条 `handoff` `{state:"waiting", reason:"stop-rule", …, screenshot}`；解除时的 `resume` 事件 `reason:"stop-rule"`（§18 后的 0.6-I 段）。0.7.5-A 起还有 `end`：结束规则（`sites.<名>.guard.endOn`、`fetch --end-on`）命中的响应写 `{event:"end", site, account:null, rule, request:"r-N", detail:{rule, detail, request, url, status[, fetchId]}}`，不停手、不进 `waiting`（§38）。0.6-D 起还有 `challenge`：页面上认出图片验证码时写一条提示（每个页面一次，`detail: {kind:"image-captcha", advisory:true, image, input, url[, frame]}`，`image` / `input` 是 ref），只是告诉模型，不进 `waiting`、不拦任何命令（见 §27）。
- **`protection`**（0.8-A，实际写出，§41.3）：`{tab, nav, url, detections:[{family, name, category, confidence, matched:[{rule, layer, kind, where}]}]}`，`actor:"system"`。实时识别（§41.3）在一个标签上认出的家族或其分数变了、且会话在录制时写一条（`src/daemon/protection/live.ts`）；同一份录制里还没认出过任何家族时不写，认出过之后变成没有也写（`detections:[]`）；页面在 `net start` 之前已探测过的，下一次读这份缓存结果（如 `snapshot`）时补写。`detections` 是置信度 ≥ 30 的非 `fingerprint` 家族（命令回答里只出现 ≥ 50 的）；`matched` 只有指向，没有值（§41.2）。

### 4.3 `sample` 挑战样本包（`03` §5 新增模块，P2/P3，先占位）

样本包不是新格式，是证据包的一个 **profile**：`manifest.mode.sample = true` 时录制器额外做——

- `type:"script"` 和 `document` 的正文不受 §5.2 第 4 条的大小上限约束；内联脚本随主文档正文一起在。加载顺序就是 `seq`。
- `state` 新增 `what:"env"`：在隔离世界读 `navigator` / `screen` / 时区 / 语言 / UA 等**只读**属性的快照（不改页面，不注 hook）。
  0.4-G 起 env 快照多两个字段（`source`、`fields` 10-16 作者定；字段名写法、1 KB 上限与事件其余字段按实现定案，作者 2026-10-21 批量签收）：`source` 说明快照从哪来，`fields` 是字段表本身（内联，没有 `blob`）。`tabcap fingerprint probe` 写 `{tab, what:"env", source:"fingerprint-probe", origin:<探针页的源>, count:<字段数>, reason:"manual", fields:[{name, value}|{name, hash:"sha256:…"}|{name, error}]}`：字段名是 `signals.ts` 的 IDL 名（同一 API 多个值时括号写参数，如 `WebGLRenderingContext.prototype.getParameter(VENDOR)`，或 `()` 后写结果成员，如 `Intl.DateTimeFormat.prototype.resolvedOptions().timeZone`），按代码单元序排列；值是 JSON 标量或标量数组、JSON ≤ 1 KB，超过的只留其 JSON 文本的 sha256；canvas、audio 只留字节的 sha256；所有文本过守护进程的已知秘密值替换。探针页由 tabcap 自己提供（`07` §5），在页面自己的 world 里读、只读；这一条不依赖 `sample` profile，录制中都会写。`tabcap fingerprint diff <包> --ref <名>` 取包里最后一条 `what:"env"`，与 `fingerprint probe --ref` 一样逐字段给 `same` / `differs` / `missing`（本浏览器缺、参照里有）/ `extra`（本浏览器有、参照里缺）；一个字段带 `error` 算「缺」，两边都缺为 `same`（0.4-G2 作者裁定方向）。
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
    "body": { "blob": "sha256:…", "size": 4096, "base64": false, "wireEncoding": "gzip", "truncated": false },   // 0.6-I：按 --bodies 跳过的正文是 {"skipped": "resource-type"}，此时 bodyMissing 为 null
    "bodyMissing": null                           // 或 {"reason": "...", "detail": "CDP 原文"}
  },
  "redirect": null,                               // 或 {"from": "r-56"}
                                                  // request / response 两侧可带 "decoded"：解码插件的明文视图（0.6-B，§28）
  "timing": { "start": 88120.1, "responseStart": 88122.0, "end": 88123.4, "cdp": { /* Network.ResourceTiming 原样 */ } },   // HAR 导入的包 mono 为 null，start / responseStart / end 是 epoch 毫秒，cdp 为重建的偏移（§9.2）

  "outcome": "finished",                          // finished / failed / incomplete
  "error": null                                   // 或 {"text": "net::ERR_ABORTED", "canceled": true, "blockedReason": null}
}
```

`fetchId`（0.6-A，只在 `tabcap fetch` 发出的请求上有）：`"c-<N>:f-<K>"`，`c-N` 是发出它的命令窗口，`K` 是该命令里的第几个请求（`--batch` 的第 K 行，单条恒为 1）。带 `fetchId` 的请求，`cmd` 固定是 `c-N`，不取「当时最内层打开的命令窗口」，并发命令也不串（§26）。重定向的每一跳、CORS 预检都带同一个 `fetchId`。

`fetchCredentials`（0.6-P，与 `fetchId` 同在）：这次 `tabcap fetch` 交给页面 `fetch()` 的 `credentials`：`"include"`（默认）/ `"same-origin"` / `"omit"`。同一 `fetchId` 的每一跳、预检都带同一个值；页面自己的请求没有这个字段（§34）。

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

10. 按资源类型取正文（0.6-I，10-16 作者定）：`net start --bodies all|api|api+script|none`，缺省取 `config.json` `record.bodies`，再缺省 `all`（「正文就是证据」不变）。`api` 存 `document`、`xhr`、`fetch`、`websocket`、`eventsource` 和其余非静态类型（`manifest`、`other`，含预检）的正文；`api+script` 再加 `script`（`net body --at`、追踪模式要它）；静态资源（`image`、`font`、`stylesheet`、`media`）在 `api` / `api+script` 下一律只记元数据；`none` 什么正文都不存。被跳过的正文**不向 Chrome 要**（不发 `Network.getResponseBody`；Fetch 拦截救回的也丢掉），`request` 事件照常写（状态、头、时序都在），`response.body` 是 `{"skipped":"resource-type"}`、`bodyMissing` 为 `null`；本来就没有正文的（3xx、204、304、WebSocket 握手）仍按规则 5 写原因。`manifest.record.bodies` 记模式；`net list` 的行带 `bodySkipped:"resource-type"`；`net body` 对它回 `not-found` 并说明是哪个模式跳过的、换哪个模式能存。请求体（§5.3）、WebSocket 帧不受这个开关影响。【实测 v06i：s54 一个 1.5 MiB 脚本的页面，`api` 与 `all` 两个包的 blob 字节差正好等于靶场发出的脚本 + 样式表 + 图片字节数】

### 5.3 请求体

`requestWillBeSent` 带 `postData` 就内联（≤ 64 KB），否则 `Network.getRequestPostData` 取后存 blob；取不到写 `postDataMissing`。表单、JSON、multipart 都存原样字节，解析留给分析命令。重定向链上的每一跳照同一规则存自己的请求体（0.6-D，s49）：被 302 回答的 POST 那一跳带它的 `postData`，下一跳的 `redirect.from` 指回它。

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
| 快照 ref | `e12`、`f2/f1/e7` | 来自 snapshot，**不跨包、不持久**，只在 `action.target` 里做记录。帧里的元素带帧路径（0.4-I）：`f<n>/e<m>`、嵌套 `f<n>/f<k>/e<m>`，`n` 为父文档子帧按文档顺序的序号（从 1 起） |

时间：跨标签排序只信 `seq`；时长只用 `mono`；`ts` 给人看和给 HAR 的 `startedDateTime` 用。

## 7. manifest.json

```jsonc
{
  "format": "evidence-bundle/0",
  "id": "01JA…",                                   // ULID
  "created": 1760500000000, "finished": 1760500900000,   // finished 缺失 = 未收尾
  "producer": { "tool": "tabcap", "version": "0.1.0", "daemon": "0.1.0", "extension": "0.1.0",
                "browser": { "name": "Chrome", "version": "155.0.8059.41", "userAgent": "…", "webdriver": "hidden",
                             "args": ["--user-data-dir=<profile>", "--remote-debugging-pipe", "…"], "extraArgs": [], "dropArgs": [] }, "platform": "darwin-arm64" },   // webdriver：0.7.6-A，§40；args / extraArgs / dropArgs：0.8.1-A，§42；旧包没有 = 未记录
  "session": { "name": "range-s02", "site": "range-demo", "account": "demo", "proxy": "p1",   // 只记站点名、账号名和代理名（或 system / none），与本地库靠站点名关联
               "tabs": [ { "tab": "t1", "chromeTabId": 1234, "owned": true, "firstUrl": "…" } ] },
  "mode": { "capture": "mixed", "trace": false, "raw": true, "humanRecorder": true },
  "record": { "bodies": "all" },                  // 0.6-I：net start --bodies 的模式 all / api / api+script / none；旧包没有此字段 = all
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
  - query、表单、JSON 字段：名字含 `(token|secret|passw|session|sid|auth|api[-_]?key)`，或有一段正好是 `pass` / `pwd`（按非字母数字、驼峰、字母数字交界切段：`user_pass`、`userPass`、`login-pwd`、`Pwd2` 算，`bypass`、`passport`、`compass`、`passenger` 不算；`pass` / `pwd` 为 `default@2`，0.4 作者定。`ticket` 曾在 0.7-E 加入一天，作者 10-17 定去掉：CAS 回跳 URL 里的票据对回放是录制时的常量，而这张名单同时决定 export-python 把哪些输入当 secret）。
  - 值模式：18 位身份证、11 位手机号、邮箱、JWT（`xxx.yyy.zzz` 且 base64url）。
  - `state` 事件（cookies / storage）整体打码。
- 占位符：`«r:<类别>:<sha256(salt+值) 前 8 位>»`。同一个值在整包里映射到同一个占位符，所以 `diff` 的「会话值 / 常量」分类在脱敏副本上不变。salt 只存在本地原包的 `exports/<name>.salt`，不进副本。
- 脱敏后 `manifest.redaction` 记规则版本和时间；正文 blob 被改写的，哈希按新内容重算，`counts` 重算。
- **打码不等于安全**：响应正文里的自由文本（地址、姓名）靠规则抓不全，导出给别人前人要再看一眼。这句写进 README。

### 8.1 凭据：存一次，之后只用引用

探路由 AI 做，就要把作者给的登录信息交给工具；值进库一次，之后模型只见引用。凭据住在工具的本地库（`03` §5 `store`）：

- **载体**：`bun:sqlite` 单文件 `~/.config/tabcap/state.db`（定名后换目录名），权限 0600，守护进程启动时检查权限，不对就拒跑。明文存，暂不接系统钥匙串；README 写清楚这是 `~/.netrc` 一级的保护，能用测试账号就别用主账号。库永远不在仓库里、不在证据包目录里。零安装：SQLite 随 Bun 运行时和编译产物一起带【实测】。
- **表**：`sites`（名字、入口网址、域名列表、备注）、`accounts`（站点、用户名、密码、可选 TOTP 种子，默认空；0.4-D 加 `proxy`、`state`、`cool_until`、`last_used_at`、`fail_streak`）、`login_recipes`（P2）、`sessions`（P2：最近会话 cookie、保存时间、最后验证时间）、`guard_counters`（0.4-D 加账号维度）、`bundles`（证据包索引）、`proxies`（0.4-D：代理名、scheme、host、port、用户名、密码、bypass 与健康状态）。
- **录入：推荐人手填，不强制**（10-16 作者定）：`tabcap site add example --url … --user …`（站点的第一个账号）与 `tabcap account add example --user …`（同一站点的第二个、第三个账号；`--totp-stdin` 时 stdin 两行：密码、TOTP 种子）。推荐人在自己的终端里交互输入或 `--password-stdin`，这样明文不经过模型；人也可以把值交给 AI 一次，由 AI 用 `--password-stdin` 从管道存入（不需要终端），此后只用引用。两条路都不走命令行参数，输出里不出现；扩展表单从当前标签预填入口网址（P2）。不在人手动登录时自动抓密码。
- **AI 看到的**：`tabcap site list` 给站点名、入口网址、账号名（不打码）。命令只写引用：`tabcap session start --site example`、`tabcap fill <ref> --secret example.password`。守护进程取值填入页面。
- **会话要先绑站点（0.6-R，按实现定案，作者 2026-10-21 批量签收）**：`fill --secret` 只在 `session start <name> --site <s>` 绑过站点的会话里取值。`net start`、`navigate` 照旧隐式建会话（不变），但这样的会话没有绑定；`session start --site` 失败后再 `net start --session <同名>` 建出来的也是。对未绑定会话 `fill --secret` 报 `not-found`，不碰页面、不计登录次数，`next` 是 `tabcap session stop <name>` 再 `tabcap session start <name> --site <s>`（账号的标签必须开在它自己的浏览器上下文里，所以先停）。以前未绑定会话会取该站点的第一个账号。`session start --site` 失败什么都不留：站点不在库里、账号不可用、会话已有标签等检查都在建任何东西之前；账号的浏览器上下文开了以后再出错，上下文当场销毁，不留给后来同名的隐式会话。【实测 v06r：失败的 `session start --site` 后 `session list` 里没有这个名字；`net start` 建出的未绑定会话里 `fill --secret` 被拒、密码框仍为空；照 `next` 做后登录成功】绑到站点 A 的会话 `--secret B.*` 仍按旧规则取 B 的第一个账号（未改，待作者定）。
- **输出替换**：守护进程对所有 CLI 输出、日志、`snapshot` / `evaluate` / `read_page` 的文本结果，把库里已知的秘密值替换成 `<secret:example.password>`；`cmd.input`、`action.value` 里也只有引用。AI 即使故意 `evaluate` 读密码框，拿到的也是占位符。截图里密码框本来就是圆点。
- 页面把密码回显到请求里（登录 POST 的表单体）时，正文原样进包，这是事实不能改；导出时 §8 的规则按名字和值两路打码，值的来源包括库里的密码。本地原包默认 `0700` 且不进仓库。
- **代理凭据**（0.4-D）：代理密码只走 `--password-stdin` 或交互提示；替换表里每个代理有三种写法：密码本身、`user:pass@host:port`、`base64(user:pass)`（Chrome 把 `Proxy-Authorization: Basic …` 报在 `Network.requestWillBeSentExtraInfo` 里，录制器会写进 `raw/cdp.jsonl`），一律替换成 `<secret:proxy.<name>>`。录制器写 `raw/cdp.jsonl` 与 `events.jsonl` 时只替换代理凭据（站点密码仍按上一条原样留在登录请求里）。Chrome 只拿到 `host:port`，认证由守护进程在浏览器会话上用 `Fetch.enable {handleAuthRequests:true}` → `Fetch.authRequired` → `Fetch.continueWithAuth` 应答；这是插桩，开着时每条命令输出带 `fetchAuth:"on"`。
- manifest 记 `session.site`、`session.account`、`session.proxy`（0.4-D，名字），证据包与库之间只靠站点名关联。
- 验证：`06` §2 的「凭据不泄漏」检查、A2.9。

### 8.2 会话导出 `session export`（0.6-F，10-16 作者定设计；细节按实现定案，作者 2026-10-21 批量签收）

`tabcap session export --for requests|httpx|playwright --out <file> [--origin <url 或 host>] [--tab t2]`：把会话当前标签（或 `--tab`）已登录的会话交给脚本。导出源默认是标签页面的源；`--origin` 可以是任意源（0.6-P：单页应用调用的 API 源，标签上不必有它的 frame），写裸 host（`api.example.com`、`127.0.0.1:4311`）时 scheme 取录制里发往该 host 的最近一条请求，没有就用 `https`。和 `replay session` 一样，**文件里就是活的凭据**，这是设计本身，不打码。

- **写到哪**：`--out` 给的路径（CLI 按自己的工作目录解析）；`--for httpx` 没写 `.py` 时补上。文件 0600，新建的目录 0700（已有目录不改权限）；路径是目录则拒绝。不写进证据包，不进仓库（使用者自己负责）。
- **装什么**：
  - cookies：`Network.getCookies` 的 URL 是导出源的根 URL、标签页面的根 URL 与当前 URL（0.6-P 起总带上，`--origin` 的源与页面的并列）、读 storage 的那个 frame 的 URL、头取自的那个源的根 URL；会话有自己的浏览器上下文（池账号，0.4-D）时再并上 `Storage.getCookies {browserContextId}`，名字 + 域 + 路径相同的后者覆盖。字段同 Playwright storageState 的 cookie。
  - 头：本会话正在录或最近录完的包里（不论哪个标签），**发往导出源 host（含端口）的最近一条带选中头的请求**（都不带就取最近一条、头为空）；0.6-P：没给 `--origin` 且这样选出的头里没有像认证的头（下句的敏感头类）时，改取「最近一条带敏感头的请求里敏感头最多」的那个录到的 host（并列取更晚的），输出 `source.headers.auto: true` 并在 `note` 里说明；给了 `--origin` 不做这个回退。选中 = 敏感头（§8 的头规则，另加 `x-csrf*`、`x-xsrf*`、`*-token`、`*-auth*`、`api-key`）或页面自己设的头（不在浏览器默认头表里：Fetch 规范的禁止请求头、`sec-*`、客户端提示、缓存与条件请求头、`content-type` / `content-length` 等）。`cookie` 单独走 cookies；`proxy-*`（池代理凭据）和伪头永不导出。没有录制：`headers:{}`、`source.headers:"none"`，提示先 `net start`。
  - storage：在导出源那个 frame 的 tabcap 隔离世界里读 localStorage / sessionStorage（与页面共享存储，不碰页面 JS）；UTF-8 超过 64 KB 的值跳过并在输出里列键名和大小。标签上没有导出源的 frame 时（API 源），读页面的 storage 并在 `note` 里说明（0.6-P 起不再 `not-found`）；读的是哪个源记在 `storageOrigin` / `source.storage`。
- **格式**：`requests` = JSON，schema `tabcap-session-export/0`：`{schema, origin, capturedAt (ms), cookies:[{name, value, domain, path, expires, httpOnly, secure, sameSite}], headers:{名:值}, headersFrom:{request, origin, auto}, storage:{localStorage:{}, sessionStorage:{}}, storageOrigin, note}`（`headersFrom`、`storageOrigin` 为 0.6-P 新增）；`httpx` = 可直接 import 的 Python 模块（`cookies` 名→值、`COOKIE_RECORDS` 带域和路径、`headers`、`storage`、`HEADERS_FROM` / `HEADERS_ORIGIN` / `STORAGE_ORIGIN`、`client(base_url)` 返回 `httpx.Client(cookies=…, headers=…)`，运行时只依赖 httpx）；`playwright` = `replay session` 的 storageState，不加字段（localStorage 记在实际读到它的源下），放不下的头和 sessionStorage 在输出 `omitted` 里报名字与数目。`replay export-python` 生成的包里附 `_tabcap_session.py`（读 `requests` 格式、建 httpx 客户端，不依赖 tabcap）。
- **输出**：`{file, for, origin, mode:"0600", cookies:n, headers:[名字], storage:{localStorage:n, sessionStorage:n}, source:{headers:{request:"r-N"|null, origin:<源>|null, auto:bool}, storage:<源>|null}, skipped?, omitted?, note}`（0.6-P 起 `source.headers` 是对象，原来的 `"none"` 成了 `request:null`），只有路径、计数和头名，不出任何值；守护进程的已知秘密替换照常作用于输出。录制中照常写 `cmd` 事件（`outputSummary` 是计数），包里不写别的。
- 验证：`test/unit/session-export.test.ts`（头选择表、64 KB 上限、文件权限、三种格式、生成的 httpx 客户端对本地服务器实际发出的 cookie 与头；0.6-P 的 `authSource` 回退、`originArg`）、`test/e2e/v06f.e2e.test.ts`（s07 带 token 变体，对照靶场日志）、`test/e2e/v06p.e2e.test.ts`（`05` s60：标签在 A 上 `--origin <B>` 拿到页面发往 B 的 `Authorization` 与 B 的 cookie；不给 `--origin` 自动回退到 B）。

### 8.3 实时输出脱敏（0.6-E，10-16 作者定；细节按实现定案，作者 2026-10-21 批量签收）

真实项目试用里 `net show` 明文打出 `access-token`、`Authorization: Bearer …` 和会话 cookie，`net list` 打出 URL 里的 token；只有 HAR 导出打了码。现在守护进程的实时输出也按 §8 的名字规则（`default@2`，0.7-E 起 `default@2`）显示成 `<redacted:<名字>>`：

- **范围**：`net show`（URL、请求 / 响应头、postData 的内联文本与 blob 的 `head`；超过 2 KB 的内联正文落成 `exports/post/<id>.redacted.txt`；`bytes` 仍是录到的字节数，0.7-C 前叫 `size`）、`net list`（每行的 `url`，`--kind ws` 的帧 URL）、`net body`（答案里的 `url`；它不输出头）、`fetch` 与 `POST /fetch`（信封里选出的响应头；`location` 按 URL 规则）、`recon`（答案与 `exports/dossier.json` / `.md` 里的页面 URL、guard 检测的 URL）、`trace list`（每行的脚本 URL；行里不带参数值）。
- **规则**：名字属于敏感头集合或命中名字规则的头，整值换成 `<redacted:头名小写>`；`cookie` / `set-cookie` 保留 cookie 名和属性，每个值都换（§8 的 state 规则：全部值）；`location` / `referer` / `content-location` 头与各处 URL 只换名字敏感的 query 参数，其余逐字不变（fragment 不动）；请求体：JSON（对象 / 数组）里任意深度名字敏感的键（有改动才紧凑重排，否则原文），表单体逐字段。值规则（邮箱、手机号等）不用在实时输出上。
- **库里的秘密**：整值是库里已知秘密的，仍显示 `<secret:<站点>.<字段>>`（§8.1 的替换照常作用于所有输出，`--reveal` 也不例外）。
- **`--reveal`**：上述命令都收（`POST /fetch` 收 `reveal: true`），打印录到的原值；只在人要求时用。
- **离线分析的输出（0.7.3）**：`analyze diff`（JSON 与 `--text`）、`analyze deps`、`analyze chain`、`analyze recon` 也按同一套名字规则脱敏——cookie 值、`authorization` / `set-cookie` / 名字敏感的请求头、名字命中 `(token|secret|passw|session|sid|auth|api[-_]?key)` 或 `pass` / `pwd` 一字的 query / JSON / form 值显示成 `<redacted:<sha256 前 8 位>>`；同一个值在整份回答里是同一个占位符，所以 `diff` 的对照仍成立。分类 / 依赖计算仍读原值，只换输出层；`--reveal`（这几个子命令）打印原值。`analyze shape` 本来只出类型、格式与非敏感字段的枚举字面量，没有值可换。
- **不变**：证据包照原样记录（请求事件不改，它就是证据），HAR 导出照旧打码；`analyze` 系列命令的内部计算读原包，只有上面列出的输出层被换。
- 验证：`test/unit/liveredact.test.ts`（规则表）、`test/e2e/v06e.e2e.test.ts`（`05` s07 token 变体：`x-csrf` 原样，`sid` cookie、`Authorization`、URL 的 `token` 参数打码，`--reveal` 还原，包里是原值）。

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

`--rules <file>`（0.6-C，§31）只把回放键规则的 `ignoreQuery` 参数从 `request.url` 与 `queryString` 去掉，别的不变。另见 §31 的 `bundle export fixtures`（按同一份规则出夹具）。

### 9.2 导入 `tabcap bundle import har <file> -o <bundle>`

- `entries` 按 `startedDateTime` 排序后分配 `seq`；`pages` → `nav`；`_webSocketMessages` → `ws`；有 `log._events` 就整体恢复。
- 正文：`content.text` 存在时，`encoding:"base64"` 先解码；若 `content-encoding` 头存在且字节像压缩流（gzip 魔数 / 尝试 br 解码成功），解压后存、`wireEncoding` 记原值；解不开就原样存并 `bodyMissing:null`、`body.decodeFailed:true`，让 `find` 的解码链再试。
- `manifest.imported` 记来源与 `lossy` 列表；`actor` 一律 `"human"`（外部包无法区分），`tab` 一律 `t1`。
- **资源类型**（没有 `_resourceType` 时，0.6-N，作者 10-16 定；固定表，按序取第一个命中的）：

  | 优先 | 来源 | 映射 |
  |---|---|---|
  | 1 | `_resourceType`（DevTools） | 照用，不标 `typeInferred` |
  | 2 | 请求头 `sec-fetch-dest` | `document`、`iframe` → `document`；`script`；`style` → `stylesheet`；`image`；`font`；`audio`、`video` → `media`；`empty` → 有 `x-requested-with: XMLHttpRequest` 为 `xhr`，否则 `fetch`；其他值（`worker`、`frame` 等）落到第 3 步 |
  | 3 | 响应 `content-type`（缺则取 `content.mimeType`） | `text/html` → `document`；含 `javascript` → `script`；`text/css` → `stylesheet`；`image/*` → `image`；`font/*` → `font`；`audio/*`、`video/*` → `media`；含 `json`、含 `xml`、`text/plain` → `xhr`；其他 → `other` |

  推出来的类型在导入的 `request` 事件上带 `typeInferred: "sec-fetch" | "content-type"`（有 `_resourceType` 时没有这个字段），别把它当成浏览器自己的分类；`tabcap bundle info` 输出 `typeInferred: {"sec-fetch": n, "content-type": n}` 计数。状态 0（没有响应）的请求无从推，`type` 为 `other`、不标。默认 HAR 导出不写 `typeInferred`；`--embed-events` 经 `log._events` 原样保留。`replay export-python`、`analyze` 因此能处理 mitmproxy 的导入包。
- **耗时**（0.6-N）：HAR `time` 与 `timings.{blocked,dns,connect,ssl,send,wait,receive}`（`-1` 或缺 = 未知，略去）映射到 `timing`：包里没有单调时钟（`mono:null`），`timing.start` 取 `startedDateTime` 的 epoch 毫秒，`end = start + time`，`responseStart = end - receive`（没有 `time` 或 `receive` 时取 `start` 加 blocked / dns / connect / send / wait 之和），`timing.cdp` 重建为自 `start` 起的偏移：`dnsStart/dnsEnd`（接在 blocked 之后）、`connectStart/connectEnd`、`sslStart/sslEnd`（HAR 1.2 的 ssl 含在 connect 内，放在 connect 末尾）、`sendStart/sendEnd`、`receiveHeadersEnd`；没有 `requestTime`。一条里一个数都没有时 `timing` 为 `null` 并在 `lossy` 里列 `timing`。往返：`bundle export har` 读回 `time` 与已知的各段（1 ms 内）；`blocked` 未知而后面的段已知时读回 `0`（`cdp` 的偏移从 0 起），`dns` 等未知的读回 `-1`。HAR 里没有对应物的字段（`_securityState`、`connection` 等）仍然丢弃并按 `lossy` 列出。
- 验收用的来源：Chrome DevTools 导出、我们自己导出（往返）、mitmproxy `hardump`（若本机有）。Charles 没有样本就不承诺。
- mitmproxy `hardump` 的实测样本在 `test/fixtures/har/mitmproxy-range.har`；它的字段丢失表与导入后各命令的行为见 [docs/13](13-interop-proxies.md) §2（0.6-N 起导入后 `type` 由上表推出，`replay export-python` 能生成）。

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
- **looks-signature** 按字面：hex 或 base64 字符集且长度 32 / 40 / 64 / 128，与 looks-random 互斥。0.7-E（按实现定案，作者 2026-10-21 批量签收）：形如业务编号的值不算——全是数字、前面最多 4 个字母、字母与数字之间最多一个 `-` / `_`（`^[A-Za-z]{0,4}[-_]?\d+$`，如 `AB` + 30 位数字）；真实站点把这样的长编号当成了签名【实测：上手验收，站点匿名】。looks-random 未改。
- **无值的 query 键（0.7-E）**：`?queryList&id=1` 里没有 `=` 的 `queryList` 不是参数（它在 URL 里点名方法或视图，没有值）：`analyze diff` / `deps` / `chain` 都不把它当输入，`replay export-python` 把它原样留在 URL 字面量里（生成的 `_send` 在 URL 已带 query 时把参数接在后面，不让 httpx 改写成 `queryList=`）。【实测 单测 `test/unit/diff.test.ts`、`test/unit/replay-chain.test.ts`】
- **`analyze deps` 的类（0.6-E 补，10-16 作者定；表与值形状按实现定案，作者 2026-10-21 批量签收）**：有来源的类 = 来源种类（`set-cookie` > `response` > `action` > `request` > `constant` > `timestamp`）；没有来源时按顺序判：cookie 是 `unrecorded`；**`caller-input`**（调用方自己选的值）= 不是 cookie、没有 `looks-signature` / `looks-random` 提示、名字不敏感（§8 的名字规则与头规则），且名字在下表里，或这组请求录到的每个值都是「普通值」（< 6 位的数字、`true` / `false`、`yyyy-mm[-dd]` 或 `yyyy/mm[/dd]` 日期（可带 `Thh:mm[:ss]`）、一个 ≤ 24 字符的单词：字母开头，只含字母、`_`、`-`）；其余 `computed-in-page`。名字表（比较时转小写、去掉 `_` `-` `.`，去掉 `[n]`）：`page pageno pagenum pageindex pagesize perpage size limit offset count from to since until startdate enddate date period interval year month week day groupby sort sortby order orderby q query keyword search lang locale`。`caller-input` 不进 `unresolved`、不写 finding；`analyze chain` 把它列在 `inputs`（不在 `todo`）；`analyze chain` 的默认目标「最后一条有数据的 xhr / fetch / document」指**开始时间最晚**的那条（`timing.start`，没有就用 `mono`；事件顺序只在并列或缺时间时兜底；0.6-E：请求编号在响应写入时才分配，登录 POST 可能排在数据请求之后）；`replay export-python` 的链模式把它生成为普通参数、默认值是录到的第一个样本的值（JSON 叶子保留类型），没有 TODO。
- **带前缀的头值（0.6-E）**：`x-*` / `authorization` 头的值与响应叶子直接比不上时，去掉开头的 `Bearer ` / `Basic ` / `Token ` / `JWT `（大小写不限，后跟空格或制表符）和成对的首尾引号（`"` 或 `'`）再比；这样的来源多 `prefix`（去掉的开头，含引号）与 `suffix`（去掉的结尾引号，没有时不写），`analyze chain` 的 `provides` 同样带上。`--write-findings` 去掉前后缀后复读叶子，一致记「实测」。`export-python` 的参数是去掉前后缀的值，发送时拼回（`"Bearer " + authorization`），`verify()` 照旧从上一步答复的路径取。
- **`export-python` 的请求头（0.6-E）**：默认只发 `content-type`、`authorization`、非 Chrome 默认值的 `accept`（默认值 = `*/*`、导航的 `text/html,application/xhtml+xml,…`、图片的 `image/avif,…`、样式的 `text/css,*/*;q=0.1`）、源与请求不同的 `referer`，以及不在浏览器默认头表（§8.2 `session export` 的那张：禁止请求头、`sec-*`、客户端提示、缓存与条件请求头等）里的头；被去掉的头也不生成参数。`--browser-headers` 照录到的全部发送（0.6-E 之前的行为）。
- **链的默认目标（0.6-E 定规则，0.6-C 统一）**：`analyze chain` 不给 `--request` 时，与 `replay export-python` 的链模式用**同一条规则**（`src/analyze/chain.ts` `latestTarget`）：有数据的 xhr / fetch / document 请求（2xx、录到非空正文）里**开始时间最晚**的那条（`timing.start`，没有用 `mono`；事件顺序只在开始时间相同或缺失时兜底），都没有就取这几类里有响应、开始最晚的。`export-python` 只在 `--include` / `--exclude` 选中的请求里挑；事件顺序与开始时间相反时两者选同一条（`test/unit/replay-chain.test.ts`）。0.7-E：`export-python --request r-N` 与 `analyze chain --request` 同义（隐含链模式；目标不在导出的请求里时 `not-found` 并说原因，与 `--no-chain` 同用是用法错误）。

代码待改（排进 0.2-C）：
1. `types.ts` 的 `CmdEvent` 改为 start / end 两种形状；`reader.ts` 不再把 `status:null` 读成 0；HAR 导出对 `cmd` 对与 `console` 的处理（列入 dropped）。
2. 熵阈值按长度分档：≥ 1 KiB 用 7.3 bit/字节，256 B 到 1 KiB 用 7.0，低于 256 B 不判。
3. `finding.evidence` 类型补 `{console}`。

## 16. 0.2-D 裁决（10-15，来自真实站点试用报告）

- **`actor` 的默认值**：`direct` 模式下人只在交接时刻介入，所以一切事件默认 `actor:"ai"`；只有 `handoff` 进入「人在操作」状态期间才标 `human`。此前「命令窗口外即 human」的规则作废，它把 AI `navigate` 带出的后续请求错标成了 human。`ext` 模式接管用户自己的 Chrome 时再引入时间窗判定。
- **`net wait` 的回看窗口**：默认回看到最近一条**动作类**命令（navigate / click / fill / type / press / go / reload / evaluate）的开始时刻，跳过只读命令（wait / snapshot / find / screenshot / console / net list / tabs）；另加 `--since <c-id>|start` 指定起点、`--fresh` 只等新的。超时的 `next` 要列出「更早已完成的匹配」。
- **包内文件权限**：`events.jsonl`、`manifest.json`、`blobs/` 一律 0600，目录 0700，与 `raw/` 一致。
- **弹窗归属**：opener 是本会话 owned 标签的弹窗也算 owned；`session stop` 关掉它们；借来的仍不关。
- **关标签后的 current（0.7.3）**：`tab close` 关的是当前标签时，自动把最近成为 current 的 owned 标签设为 current（没有记录就取最后打开的 owned）；借来的（非 owned）标签不参与，会话没有别的 owned 标签时 `current:null`、后续动作命令仍报 `no-tab`。回答里 `current` 是新值。

## 17. 0.2-D 裁决（10-15）

按实现定案：`net list --failed` 表示只看失败项，`--all` 看全部，默认隐藏失败与 `data:`；`--since c-N` 与 `net wait` 回看都以请求写入包的时刻为基准；录制中动作命令的输出带 `cmd` 字段；新增错误码 `needs-await`；`net list` / `console list` 从最早开始分页：不给分页参数时返回第 0 页、每页 100（还有下一页时带 `nextPageIdx`），`--page-size 0` 返回全部（0.4 作者定）；`net show` 的 initiator 行列号从 1 起，包内保持 CDP 原始从 0 起，script 类发起者从调用栈顶帧补 url / 行 / 列；`find.ref` 仍是最近带 ref 的祖先，该点的是 `clickable`；还前台的判据是「每条命令结束后读到的最前应用」。
代码待改：`timing.responseStart` 可能晚于 `end`（两个时间戳来源不同），录制器统一到 CDP 单调时钟；HAR 导出文件改 0600；`type` 对当前焦点元素补 `isConnected` 检查。

## 18. 0.3-A 裁决（10-15）

作者定：外部处理程序给出答案后会话直接恢复，答案作为不可信数据交给 AI；每次调用进证据包并计入该站点 guard 计数，按站点配置「处理后仍需人确认」留待后续。
解码插件（0.6-B）用同一个插件目录与启用列表，清单带 `kind:"decode"`，协议是 stdin / stdout 上的 JSON 行，见 §28；已有的 mitmproxy addon，`response(flow)` 的函数体通常可以原样搬进模板 `templates/plugins/decode-python/` 的 `decode(flow)`。
按实现定案：登录尝试在 `fill --secret ...password` 时计数、按会话实例计、`--confirm` 的那次也计；`waiting` 用失败信封（`ok:false`，退出码 1），命令执行期间撞上则本条直接返回 `waiting` 并把原结果放 `error.result`；只拦 AI 的操作命令，不拦页面自己的请求；`raw/cdp.jsonl` 里同一登录 POST 的原始行是明文的第二处，与 `raw/` 的 0600 一致；`session stop` 不清 `waiting`，只有 `handoff continue` 清；处理程序命令组叫 `plugin`，启用列表 `plugins/enabled.json`，目录组或他人可写则拒用；密码少于 3 字符不做替换，`site add` 对少于 8 字符的密码告警；站点名 `[A-Za-z0-9_-]{1,64}`；识别规则目前只有「录制中的 HTML 403」，其余形态按范围规则等靶场场景。

0.6-I 站点停手规则（10-16 作者定设计；下列细节按实现定案，作者 2026-10-21 批量签收）：`config.json` `sites.<站点名>.guard: {stopOn:[规则…], consecutiveNon200:N}`，规则语法与 `tabcap fetch --stop-on`（§26）相同。guard 对会话里**每一条录下的最终响应**求值：类型限 `document` / `xhr` / `fetch`（页面 XHR、`tabcap fetch`、导航），重定向中间跳（`bodyMissing:"redirect"`）、预检（`other`）、静态资源与脚本、没有状态码的失败请求不算；URL 归哪个库站点按 §26 的同一规则（先会话绑定的站点，再入口主机或 `domains`），只有该站点配了 `guard` 才查。正文类规则（`empty-body`、`json:`、`text:`）只在正文确知时求值：`finished` 且存了正文（204 / 304 当空正文），被 `--bodies` 跳过、未完成、被逐出的只跑状态码规则；文本按 `net body` 的规则解码并做已知秘密值替换。`consecutiveNon200`：按会话 × 站点计数，任何 2xx 归零，其余状态（含 3xx 最终响应、4xx、5xx）加一，到 N 即命中（规则名 `consecutiveNon200:N`），命中后清空。**排序依据（10-16 作者定）**：按响应到达时间排，即响应完成的 CDP 单调时刻（与该请求 `timing.end` 相同；页面没读正文、`end` 为 null 的用 `timing.responseStart`，再没有用 `timing.start`，都没有的排在最后），不按录制器写出事件的顺序——页面不读正文的响应按 §5.2 规则 9 晚 1 s 写出，会写在其后完成的请求之后【实测：s55 第一版页面不读正文时，`fetch` 的 500 先于更早的页面 200 写出】。判定时机不变：每条请求写出时，把它插到到达顺序里的位置，看包含它的那段连续非 2xx 有多长，够 N 即命中（每个会话 × 站点保留最近 256 条）。命中时：响应照常录下；写 `guard` breaker（§4.2）与 `handoff` waiting（附截图）；该站点所有会话的 `fetch` 以 `guard.stopped` 拒绝，本会话的页面操作命令（`waiting` 那一组）也以 `guard.stopped` 拒绝（不是 `waiting`），只读命令照常并带 `handoff` 字段；触发它的那条命令：`fetch` 回 `fetch.stopped`（`reason:"stop-rule"`，带 `result`），其他命令回 `guard.stopped` 并把原结果放 `error.result`。解除：`handoff continue`（人或 agent 判断后）同时解除该会话引起的站点停止；`guard resume --site` 也同时结束该站点规则引起的 `waiting`（回 `handoffResumed`）。停手期间不再求值、不计数。不冷却账号、不调用 challenge 处理程序。`fetch --stop-on` 是每次调用的覆盖：给了它，这一次的响应不跑站点的 `stopOn`（照 0.6-A 只跑 `fetch.stopOn` + `--stop-on`，命中照旧 `fetch-stop`、不进 `waiting`），但仍计入 `consecutiveNon200`。配置里的坏规则：`net start` 直接 `bad-input`；录制中改坏的只记日志、不查。登录次数限制不变。0.7.5-A 起同一对象还收 `endOn`（列表结束规则，先于 `stopOn` 与计数判定，命中不停手，§38）。

## 19. 0.3-C 裁决（10-15）

按实现定案：`state` 快照在录制开始、每次根框架 `navigation` 提交、录制结束各一条（`reload` / `back_forward` 不取；`about:blank` 也写，origin 为 null）；先 `net start` 后 `navigate` 的会话第一条就是 nav 那条；`store.sessions` 只在 `session stop` 与人执行 `handoff continue` 时写，处理程序自动恢复不写；库中 ≥ 8 字符的 cookie 值视为秘密，替换成 `<secret:站点.cookie.名>`；`responseStart` 取 ResourceTiming 的 `receiveHeadersEnd` 并夹在 `[start, end]`，旧包不回填；`type` 在焦点回到不可编辑的 `<body>` 时也报 `stale-ref`；salt 文件 0600；截图失败或纯色时走焦点仿真重截，`screenshot` 命令同样适用，页面会短暂变 visible。
待作者定：页面从不读取响应体的请求（Chrome 不发 `loadingFinished`）目前只能在 stop 时收尾为 `incomplete`，录制中对 `net list` / `net wait` / guard 不可见。提案：`responseReceived` 后 1 s 仍无 `loadingFinished` 且 Fetch 已取得全文，则写成 `outcome:"finished"`、`end:null`、`bodySource:"fetch"`、`unreadByPage:true`。
作者定（10-15）：照提案采纳，已并入 §5.2 第 9 条，0.3-E 实现。

## 20. 0.3-E 裁决（10-15）

按实现定案：`--trusted` 的降级只有「确认不了绘制」一种，元素无盒子仍报 `page`；散布只有代码开关；`type --trusted` 不做绘制确认，只靠每条 5 s 超时；`--delay` 指两个字符之间的间隔；默认 `type` 与 `--insert` 都标 `eventShape:"insert"`；`unreadByPage` 只在 1 s 时查一次；这类 `finished` 请求进 HAR 时 `time` 为 -1（HAR 1.2 未规定负值，沿用现有约定）；升格的探针页去掉了指纹与 CDP 探针段，只保留输入事件记录。

## 21. 0.4-F 按实现定案（10-16，作者 2026-10-21 批量签收）

追踪模式实现时按字面解的几处：`trace start` 不要求在录制，未录制时只在内存里计数（`trace status` 可见），`signal` 只写进正在录的包，输出带 warning；`net start` 时追踪已开则这份包从此开一个窗口；`firstN` 按 (api, 调用位置 url:line:col) 跨文档计「带栈的事件」条数（不是每文档每次命中）；一条事件只有一个 `stack`（首次命中的栈）；`get` / `call` 的 `args` 为 null（函数调用断点的暂停里拿不到原生函数的实参），只有 `event` 有 `args`；worker 不读 `value`；`window.devicePixelRatio` 在 CfT 155 上是全局对象自有的访问器、原型链上没有，按「else skip and say so」跳过，`trace status` 的 `skipped` 写明原因；窗口两端用 `note` 事件的 seq；`trace list` 的 `--api` 精确匹配、`--script` 子串匹配；`trace start` 自己的输出带那句提示（即「trace start 之后的第一条输出」），`trace status` 也带。

## 22. 0.4-J `recon` 侦查档案（10-16 作者定范围；文件字段按实现定案，作者 2026-10-21 批量签收）

作者定：`recon` v0 只答四问（技术栈、数据通道清单与覆盖率、cookie 分类、防护识别），产出 `exports/dossier.json` + `exports/dossier.md`，回执进 `cmd` end 的 `outputSummary.receipt`，不另立 kind；`--probe` 推 0.5。

- 文件：`<bundle>/exports/dossier.json`（schema `tabcap-dossier/0`）与 `dossier.md`，0600，`exports/` 0700；每次 `tabcap recon` / `tabcap analyze recon <包>` 覆写。守护进程写入前过已知秘密值替换。和 HAR 一样不参与分析，`bundle redact` 的副本不带。
- `dossier.json` 顶层：`{schema, bundle, session, generatedAt(epoch ms), page:{url,title,source:"live"|"recorded-document"|"none",request?}, stack:[…], channels:[…], coverage:{ratio,total,found,unmatched,capped}, cookies:[…], protection:[…], grades:{…}, notes:[…], warnings:[…]}`。`notes` 放「只识别、不绕过」那句，`warnings` 放包未结束、无当前页面等。
- `stack`：`{source:"adapter", name, category, confidence, evidence, grade}`（当前页面上每个适配器的 detect 结果，离线没有）、`{source:"header", marker, value, hint, request, requests, grade}`（值照录，截 200 字符）、`{source:"cookie", marker, name, hint, request, grade}`（只有名字，从不写 cookie 值）；全部【推断】。
- `channels`：`{method, template, type, body:"json"|"html"|"fragment"|"text"|"binary"|"ws"|"sse", count, first:"r-N", status:[…], unreadByPage:<条数>, decode:[find 步骤名], tokens}`，按首条请求的 seq 排。
- `cookies`：`{name, carrier:"cookie"|"header"|"query"|"body", origin, setBy:[r-N…], lifetime:{kind:"session"}|{kind:"persistent",expires}|null, flags:{httpOnly,secure,sameSite}|null, role, requiredBy:[{request,input,via,grade}]}`；`origin` 为 `{kind:"set-cookie",request}` / `{kind:"session-start"}` / `{kind:"unrecorded"}`，非 cookie 的 csrf 输入为 `{kind:"deps", class, request?, path?, cookie?, grade}`。
- `protection`：`{source:"guard", kind, request, url, status, handedToHuman:{question,screenshot}|null, resumedBy, grade:"实测"}`、`{source:"response", signal, label, name, count, requests, grade:"推断"}`（只有头名字，不写值）；0.8-A 起另有 `{source:"family", family, name, vendor, category, confidence, layers, matched, combination, grade:"推断"}`（§41.2，排在最前），`cf-mitigated` / `x-amzn-waf-action` / `x-datadome` 三条从 response 信号移进家族规则。0.8-A 顶层加 `fingerprinting:[{technique, family, apis, callers:[{url, count}], attributedTo}]`，`grades.protection` 加 `family:"推断"`。

## 23. 0.4-I 按实现定案（10-16，作者 2026-10-21 批量签收）

帧路径 ref 实现时按字面解的几处：录制器至今不写 `action` 事件（0.3-B 起的现状，见 NOTES），所以「`action` 事件带 `frame`」落在动作命令自己身上：`click` / `hover` / `fill` / `upload`（以及带帧 ref 参数的 `evaluate --function`）的输出多一个 `frame`（帧路径，根文档不写），因而进了该命令 `cmd` 结束事件的 `outputSummary.frame`；`cmd` 开始事件的 `input.ref` 保留原样的 ref 字符串（`f2/f1/e7`）。将来真正写 `action` 事件时，`target.frame` 就填这个帧路径。帧头里的 same-origin / cross-origin 相对父帧的 security origin（s22 的 `f2/f1/f1` 与它的父帧同在 B 源，所以是 same-origin）。只有带子帧的页面在 `snapshot` / `outline` 的 JSON 里有 `frames` 字段、头里有 `frames` 行；遮挡项在帧里时带 `frame`，含 iframe 的遮挡项带那个 iframe 的帧路径 `layerFrame`（iframe 里的关闭按钮并进 `close`，choices 不并，0.3-D 的 `OVERLAY_EXPECTED` 不变）；根文档 ref 的动作输出不带 `frame`。没有子帧的页面，输出的字段和行与 0.4-I 之前相同。

## 24. 0.5-C 输出预算的导出文件（10-16 作者定规则；文件名与摘要按实现定案，作者 2026-10-21 批量签收）

作者定：命令回答的 `data` 序列化后超过 `TABCAP_OUTPUT_LIMIT` 字节（默认 16384，环境变量可改）时，整份 `data` 写进文件，回答的 `data` 换成 `{summary, file, bytes, truncated:true}`；命令带 `--full` 时原样全打。`net list` / `console list`（分页）与 `snapshot`（`--max-chars`）有自己的机制，不受此限。

- 文件：会话正在录制时写进该包的 `exports/<command>-<seq>.json`（`<command>` 为命令词连字符，如 `analyze-deps`；`<seq>` 为该目录里同名文件的最大序号加一，从 1 起）；没有在录（含所有离线命令）时写 `<cache>/outputs/<YYYYMMDD-HHMMSS>-<command>.json`（同秒重名加 `-2`、`-3`…）。0600，目录 0700。内容是整份 `data` 的 JSON（2 空格缩进），守护进程命令的 `data` 已过已知秘密值替换（§8.1）。和 HAR、侦查档案一样不参与分析，`bundle redact` 的副本不带。
- `summary`：顶层每个标量字段原样（字符串 200 字符以内），数组、对象与更长的字符串换成长度；非对象的 `data` 记 `{type, length}`。命令自带的摘要叠加在上面：`analyze deps` 加 `inputs`（前 10 个请求的输入数，0.7-C 起；总数在 `inputCount`）与 `unresolved`（未解析数），`recon` / `analyze recon` 加档案的 `summary` 块与 `page`，`trace list` 加 `rows: [{api, script, count}]` 与 `totals`，`where` 加前 5 个 `candidates`、`candidateCount` 与 `query`。
- **0.7-C：摘要不再只剩长度**。凡回答可能超限的命令都有自己的摘要：关键计数加前 10 个 id / 键（`SUMMARY_FIRST`），长字符串只给字符数。`net show`（头的个数与前 10 个名字、`postData` / `body` 的 `bytes` 与路径）、`net body`（`previewChars`；`--grep` 的 `matchCount` 与前 10 个 `{line, col}`；`--lines` 的 `lineCount` 与行号）、`net grep`（`requestCount`、前 10 行 `{id, url, count}`、`skippedCount`）、`analyze find`（`hitCount`、前 10 个 `{ref, part, path, match, decode}`、`searched` 的四个计数、`suspectEncrypted` 的 ref）、`analyze deps`（`requests`、`inputCount`、前 10 个请求的输入数 `inputs`、`edges`、`unresolved` 与前 10 条 `unresolvedFirst`）、`analyze chain`（`stepCount`、前 10 步的 `id`、`todo` 与 `todoFirst`、`inputs`）、`analyze diff`（`bundles`、`groupCount`、前 10 组 `{key, samples, sessions}`、`summary`）、`analyze shape`（`endpointCount`、前 10 个 `{key, exchanges, notJson}`、`unshaped`）、`analyze schema-diff`（`summary`、`bundles`、`endpointCount`、前 10 个变化的端点及其增删改个数）、`bundle info`（`counts`、`kinds`、`issueCount` 与前 10 条 `{line, kind}`；`--usage` 时 `hostCount`、前 10 个 `{host, actor, requests}`、登录次数、`stops`、`windows`）、`replay check`（`totals`、`rowCount`、前 10 个不是 same 的 `{id, result}`、`skipped`）、`status`（守护进程 / 浏览器是否在跑、`sessionCount` 与前 10 个会话的状态 / 录制 / trace、`conflictCount` 与前 10 个 `{code, session}`、`handoff`）、`trace list`（`rowCount` 加前 10 行）、`bundle export fixtures`（前 10 个文件、`failed` 与前 10 条、`notPreferred`、`skipped`）、`fetch --batch`（前 10 个结果的 `{ok, id, status}` 或错误码）、`console show`（`textChars`）。分页与自带上限的 `net list` / `console list` / `snapshot` 照旧不受预算约束，不需要摘要。【实测 单测 `test/unit/disclosure07c.test.ts`：每条命令喂一份超过 16 KB 的合成回答，断言摘要有这些键、列表 ≤10 项、摘要 <4 KB】
- 按实现定案：`TABCAP_OUTPUT_LIMIT=0` 关闭预算，非整数的值按默认；`schema` 也不受此限（CLI 契约整份输出；`schema --json` 本来就是文本）；`screenshot` 不收 `--full`（0.4 已把旧 `--full` 改名 `--full-page`，仍是未知选项），它的回答只有路径，不会超；预算在 CLI 输出层做（过滤之后，见 `08` §5），超限时 CLI 向守护进程问一次当前会话的录制包位置；`cmd` 结束事件的 `outputSummary` 照旧取自完整结果。
- 0.7-F（10-17，按实现定案，作者 2026-10-21 批量签收）：`file` 是平台原生路径，Windows 上分隔符是 `\`（如 `C:\Users\…\tabcap\outputs\20261017-101549-analyze-find.json`），与回答里其它路径字段（包目录 `dir`、`bundle`、截图路径）一样都由 `node:path` 拼出，不归一成 `/`；代理拿它直接读文件即可。单测按平台分隔符断言（`dirname(file)` 等于 `join(<cache>, "outputs")`）。

## 25. 0.5-F 命令内搜索（10-16 作者定「做」；字段按实现定案，作者 2026-10-21 批量签收）

不加新的事件 kind，证据包格式不变。`snapshot --grep / --css / --xpath / --ref --depth`、`html`、`net body --grep / --lines / --at / --pretty`、`net grep` 都是只读命令：守护进程照常给每次调用写一对 `cmd` 事件（`outputSummary` 只留顶层标量），此外不往包里写任何东西（`net body --out` 仍是拷一份正文到指定路径，与 0.3-F 相同）。`html` 只写 `cmd` 事件：读 outerHTML / innerHTML / textContent / 属性走 tabcap 的隔离世界，页面脚本看不到、也不会被调用。正文搜索读的是包里的 blob（CDP 交出的正文已解压）：先按 UTF-8 解码，不是 UTF-8 时按该请求事件的 `response.charset` 解码，都不行算二进制；所有文本先做已知秘密值替换再搜索、切片，所以正则搜不到、片段里也看不到库里的秘密值。`net body --file`（0.5-F2）把同样的解码、脱敏（、`--pretty`）后的全文写到打开中的录制的 `exports/bodies/<r-N>[.pretty].<ext>`（无录制则 `<cache>/outputs/bodies/<时间戳>-<r-N>…`），0600，重复调用覆盖；二进制正文原样写出并报 `scrubbed:false`。`--pretty` 的 JS 断行只插入换行与缩进（不删字符），`--at` 收的是原始正文的 1 起行列（`trace list`、控制台栈帧给的就是这个），带 `--pretty` 时映射到美化后的行。

## 26. 0.6-A `tabcap fetch`（10-16 作者定设计；字段与下列细节按实现定案，作者 2026-10-21 批量签收）

爬虫的请求由会话里已登录的标签发出并录进包：`tabcap fetch <url> …`（agent 用，`--batch <file.jsonl>` 按序跑多条）与守护进程的 `POST /fetch`（脚本用，`templates/python/_tabcap_fetch.py`）。机制（标记头、Request 阶段剥离、发起栈兜底）见 `07` §8。包格式只多 `request.fetchId`（§5.1）、`cmd` 结束事件的 `outputSummary.requests`（§4.1）与 `guard` 的 `fetch-stop`（§4.2），0.6-P 再加 `request.fetchCredentials` 与 `cmd` 开始事件 `input.credentials`（§34），不加新 kind。

- **前提**：会话正在录制（`net start`），否则 `not-found`、什么都不发。请求在会话当前标签（或 `--tab`）主帧的 tabcap 隔离世界里用 `fetch(url, {credentials:"include", …})` 发出（0.6-P：`--credentials include|same-origin|omit` 换掉这个值，默认仍是 `include`，§34）：同源、cookie、CORS 规则都和页面自己的请求一样；相对 URL 按标签当前页面解析，只收 http(s)。请求体按页面 POST 的样子明文录下（§8.1，设计如此）。
- **成功信封** `data`：`{id:"r-N", fetchId, status, statusText, mime, bytes, headers, body?|bodyFile?|bodyBase64?, bodyMissing?, timing:{startMono, endMono, totalMs}, waitedMs, stopped?}（0.7-E 前 `totalMs` 叫 `ms`）`。`headers` 只取 `content-type`、`content-length`、`content-encoding`、`content-disposition`、`location`、`cache-control`、`etag`、`last-modified`、`retry-after`（不带 `set-cookie`），值过秘密值替换、每个截到 1000 字符。正文：文本（按 `net body` 的规则解码）且 ≤ 8 KB 时内联 `body`（已脱敏）；更大或二进制写 `bodyFile`（与 `net body --file` 同一处 `exports/bodies/<r-N>.<ext>`，文本已脱敏、二进制原样）；`--out <file>` 改写到给定路径（同样脱敏）；`--raw` / `rawBody:true` 回 `bodyBase64`（文本是脱敏后 UTF-8 的 base64，二进制原样，≤ 16 MB，超过则落 `bodyFile` 并带 `note`）。没存正文（204、HEAD 等）时 `bytes:0` 加 `bodyMissing:<原因>`。`timing` 取自录下的 `request` 事件（CDP 单调毫秒）；`waitedMs` 是排队等本主机轮次的毫秒数。整个信封受 CLI 的输出预算约束（§24），按上面的上限不会超。
- **限速**（`config.json`）：`fetch:{minIntervalMs:3000, concurrency:1, stopOn:[]}`，`sites.<站点名>.fetch` 按键覆盖（给了 `stopOn` 就替换全局的）。按 URL 的主机（含端口）排队，先到先发；一条请求在「在飞的少于 `concurrency`」且「距该主机上一条请求开始或结束（取较晚者）已过 `minIntervalMs`」时才发，`concurrency:1` 即上一条结束到下一条开始至少 3 s。命令行没有绕过它的开关（作者红线）。`--timeout`（默认 30000，最大 600000）包含排队时间：轮次会晚于时限时直接回 `timeout`，什么都不发。
- **站点**：URL 属于哪个库站点——先看会话绑定的站点（`session start --site`），再看其余站点；入口网址的主机或 `domains` 里的域（含子域）命中即是；都不中时用 URL 的主机（`host:port`）当站点键。限速配置、停手状态、`guard resume --site` 都按这个键。
- **停手规则**（`--stop-on` 可重复，加在 `fetch.stopOn` 之后，按序取第一条命中的）：`empty-body`（无正文、0 字节或只有空白）、`status>=<n>`、`status=<n>`、`json:<$.路径>=<值>`、`json:<$.路径>!=<值>`（路径 `$` 加 `.键` / `[下标]`；值能按 JSON 解析就按 JSON 比，否则按字符串；0.7.5 起 `json:` 规则只评判 JSON 正文：正文解析不成 JSON（HTML 页面、空的 204、纯文本埋点，不看 `content-type`）时不命中；是 JSON 但路径上没有值，算「无值」，与任何值都不相等。0.7.5 前非 JSON 正文也算「无值」，站点级 `json:$.code!=0` 因此在 HTML 文档上就命中【实测：s64 第一版】；要「API 回了 HTML 就停」写 `text:^\s*<`）、`text:<正则>`（u 标志，≤ 256 字符，对脱敏后的文本）。命中时：响应照常录下；命令回 `ok:false`、`error.code:"fetch.stopped"`，带 `site`、`rule`、`detail`、`request`、`fetchId` 与完整信封 `result`（含 `stopped:{rule, detail}`）；写 `guard` breaker（§4.2）；此后该站点的 `fetch`（命令行与端点）一律 `guard.stopped`，直到 `tabcap guard resume --site <站点>`，或该会话恰在 `waiting` 时由 `handoff continue` 一并解除。会话不会因此自动进 `waiting`；停手状态只在守护进程内存里，重启守护进程即清。0.7.5-A 起有 `--end-on`（列表结束规则，先于全部停手规则判定，命中回 `ok:true` 带 `end:{rule, detail}`，§38）。0.6-I 起站点另有自己的停手规则（`sites.<名>.guard`，对全部流量、命中进 `waiting`，见 §18 后的 0.6-I 段）；`--stop-on` 是对它的每次调用覆盖：给了 `--stop-on`，这次响应不跑站点的 `stopOn`。
- **其他错误**：页面的 CORS 拦下 → `fetch.blocked`，`reason` 是 Chrome 写进控制台的那句（已脱敏），`request` 是录下的失败请求，`credentials` 是这次的模式（0.6-P；`next` 的规则见 §34）；页面里请求失败（连不上等）→ `page`；在页面里超时 → `timeout`。`fetch` 和其他动页面的命令一样受 `waiting`（§4.2）与账号小时预算约束。
- **端点** `POST /fetch`：与 `/command` 同一监听、同一鉴权（POSIX 上 0600 的 Unix 套接字，Windows 上回环 TCP + 每次启动的 bearer token）；请求体 `{session, tab?, url, method?, headers?:{名:值}|[[名,值]…], body?(文本)|json?(任意 JSON 值)|form?:{字段:值}|[[字段,值]…], credentials?("include"|"same-origin"|"omit"，0.6-P), timeoutMs?, stopOn?, rawBody?}`，回与命令行相同的信封；不收 `batch`、`out`。请求体是不可信 JSON：形状不对一律 `usage`，不会让守护进程出错。每次调用一个命令窗口（`argv:null`）。

## 27. 0.6-D 守护进程修补（10-16 作者定六条；字段按实现定案，作者 2026-10-21 批量签收）

来自作者另一个项目在真实站点上试 v0.5.0 的报告（10-16）。不加新的事件 kind，请求事件格式不变。

- **DOM 支撑的 ref**：`snapshot --css` / `--xpath` 命中、却没有无障碍行的元素（UI 库把输入框、按钮从无障碍树里藏掉），现在也铸 ref：同一张 ref 表、同样绑 `backendNodeId` + 帧 + loaderId、同样随文档失效，打印成 `- (no accessible node) <input#id.class> [e31]`（文本节点等拿不到 backendNodeId 的仍无 ref）。`click`、`fill`、`hover`、`upload`、`html`、`screenshot --ref` 照收（盒模型走 `DOM.getBoxModel`，焦点走元素自己的 `focus()`，与无障碍 ref 同一条路）；`type` 打进 `fill` / `click` 聚焦后的它。`search` 多 `domRefs`（铸了 ref 的无障碍外节点数），`refs` 把它们算进去。`snapshot --ref <DOM ref>` 没有行可展开，`not-found` 并提示 `html <ref>`。
- **点击效果**：默认（DOM）`click` 从点击前到点击后的等待结束，只观察三件事：DOM 变动（目标所在文档的 MutationObserver，开在 tabcap 的隔离世界；外加目标自身的 checked / value / selectedIndex / open，它们变了不一定有 DOM 变动）、导航（该标签与目标文档会话的 Page 帧导航事件，同文档跳转也算）、新请求（`Network.requestWillBeSent`，`data:` 不算；没在录制时为这次观察临时开 Network，与 `wait --idle` 同一个引用计数开关）。输出加 `effect:"dom"|"navigation"|"request"`（最先看到的那个；同一时刻按这个顺序），什么都没看到是 `effect:"none"` 加 `note`（建议 `--trusted`）。退出码不变；`--trusted`（含降级）与 `--no-wait` 不报 `effect`；等待中弹出对话框时不读 DOM 观察。
  - **弹窗（0.6-R，来自真实项目试用 10-17：点击开了新标签，`tab list` 里已是 `popup`，回答却是 `effect:"none"` 加「试 `--trusted`」）**：同一段时间里再看浏览器级的 `Target.targetCreated` / `Target.attachedToTarget`：`type:"page"` 且 `openerId` 是被点标签的，就是这次点击开的页面（`window.open`、新窗口；Tabs 照 §16 把它记进同一会话，`reason:"popup"`、`opener`）。这时 `effect:"popup"`，**优先于其余三种**（同一个处理程序里的 DOM 变动总比新目标先看到，而新标签才是调用方接下来要操作的），输出加 `popup:{tab, url}`：`tab` 是会话里的标签 id（等待结束后再等至多 2 s 让它注册，仍没注册是 `null`），`url` 是那时已知的地址（空或 `about:blank` 时省略）；`note` 指向 `--tab <id>` / `tab select <id>`，不建议 `--trusted`，当前标签不变。只记第一个弹窗。【实测 v02d s17，CfT：3 次都是 `popup:{tab:"t2", url:".../popup-target"}`，等待约 250 ms】`<a target=_blank>`（默认 noopener）的新标签是否带 `openerId`、因而是否进会话【待验】。
  - **弹窗观察到回答为止（0.6-U，来自真实项目复测 10-17：点击先发了请求、弹窗目标在等待结束后才到，回答是 `effect:"request"` 且没有 `popup`）**：契约改为——观察到返回为止（含等待之后的宽限），只要看到这次点击开的弹窗，回答就带 `popup` 字段，`effect` 就是 `popup`（仍优先于其余三种）。DOM 变动、导航、请求三种仍只按等待期间判（与 0.6-D 相同）。等待之后有**一段**宽限，总长至多 `POPUP_REGISTER_MS`（2 s，与以前「等它注册」是同一个预算，不另加）：已看到弹窗时，等到它注册成会话标签（同以前）；还没看到时，只在「等待期间看到的某个请求仍未结束，或最后一个结束不到 300 ms」时继续看（处理程序拿到响应后才 `window.open`），否则立刻返回——所以没发请求、或请求在等待里早已结束的点击不变慢；对话框开着时不等请求。弹窗除了看 `Target.targetCreated` / `attachedToTarget`，也看会话的标签表：等待开始后新出现、`opener` 是被点标签的 `popup` 标签同样算。`wait.ms` 不含宽限。【推断】真实站点的根因是「请求返回后才开弹窗」，复测时的事件顺序没有原始日志；【待验】靶场没有「慢请求后开弹窗」的页面（需要 docs/05 新场景，待作者定），这条路径目前只有单测（`popupGraceOver`、`classifyEffect` 的「先请求后弹窗」）。
  - **宽限的边界（0.6-V，作者定，只改文档）**：点击最后一个请求结束超过 300 ms 之后才开的弹窗，不由这次点击报告（回答里没有 `popup`）；`tab list` 照样把它列为 `popup`，带 `opener`。
- **`find` 搜帧**：根文档之后按帧树（0.4-I）顺序搜每个子帧的无障碍树，帧里的命中带 `frame`（帧路径）与帧路径 ref；有子帧时输出带 `frames`（搜了几个帧），读不到的帧计入 `framesSkipped`。可点的排前面跨所有文档算。`where` 用来判日期顺序的页面文字也取自根文档加全部子帧（隔离世界里读 `body.innerText`，合计至多 1000000 字符）。
- **重定向丢请求体**：根因【实测 s49 的 raw/cdp.jsonl】：POST 的 `Network.requestWillBeSent` 带 `postData`；302 之后 Chrome 用同一 `requestId` 再发一条带 `redirectResponse` 的 `requestWillBeSent`（新的 GET，没有 `postData`），录制器在这里就地写出上一跳，写的时候没带请求体，于是 `postData:null`。现在上一跳按 §5.3 的同一规则存：能内联的照旧同步写出；要进 blob（> 64 KB）或只有 `hasPostData` 的，先存 / 先取再写，下一跳等它的 id 再写 `redirect.from`。Fetch 拦截路径（Response 阶段）不涉及请求体，没改。
- **图片验证码提示**：作者原话「guard 识别图片验证码也不一定转交，模型能自己过就过吧。就告诉模型有个什么东西拦着，它自己判断要不要喊人」。在根文档与帧（至多 16 个）的隔离世界里扫可见的 `<img>` / `<canvas>` 与文本输入框（`browser/captcha.ts`，纯函数判定）：图片的 src / id / class / alt / title / 附近标签含 captcha / verify / 验证码 / 校验码，或输入框的 name / id / placeholder / 标签像 captcha / vcode / verifyCode / 验证码 / 校验码且在登录表单旁（所在表单有密码框；不在表单里时页面上有密码框）。图片与输入框在同一表单里配对。`snapshot` / `outline` 的头多一行 `challenge  image-captcha img [e12] → input [e13]; read the image (screenshot --ref e12) or hand over (ask the human to type it)`（帧里的加 `· in f2`），JSON 多 `challenge: {kind, image, input, advisory:true[, frame]}`；对该表单的 `fill` / `click` 输出带 `challenge: {kind, image, input}`；录制中每个页面（标签 + 文档身份）写一条 `guard` `{event:"challenge"}`（`guard` 事件的新 `event` 值，§4.2）。不进 `waiting`，不拦命令，原有的挑战（HTML 403 验证页）照旧转交。
- **一账号一浏览器上下文**：`session start --site <s>`（带或不带 `--account`，含 `auto`）只要绑上账号，`direct` 模式就给它单独一个 `Target.createBrowserContext {disposeOnDetach:false}`（账号绑了池代理时再加 `proxyServer` / `proxyBypassList`，同 0.4-D）；cookie 照 0.4-D 恢复与回写（开始时 `Storage.setCookies`，cookie 状态快照、`session stop`、关浏览器前 `Storage.getCookies`）。没有账号的会话用默认 context。会话已有标签时绑账号报 `conflict`（与 0.4-D 对池账号的规则相同，现在对所有账号）。`ext` 模式只有一个 cookie 罐，没有 context，规则不变（`ext.no-context`）。

## 28. 0.6-B 解码插件（10-16 作者定设计；字段按实现定案，作者 2026-10-21 批量签收）

作者定：按站点、按方向用 host / path / content type 匹配；解码器是进程外程序，stdin / stdout 上一行一个 JSON；密钥放插件自己的配置，不进 tabcap 的库，也不进证据包；明文作为「派生视图」存在原正文旁边，`find`、`where`、`deps`、`recon`、`replay check` 都读它。作者补充（10-16）：已有 mitmproxy addon / Burp 扩展里的解密代码要能少改就复用：协议仍是这份 JSON 行，另附 Python runner 模板 `templates/plugins/decode-python/`。

**目录与清单**。和挑战处理程序同一套目录（§18）：`$TABCAP_HOME/config/plugins/<name>/manifest.json`，装上不等于启用，`tabcap plugin enable <name>` 才生效；目录组或他人可写则拒用；`manifest.json` 超过 16 KB 不读。`kind:"decode"` 的清单按不可信输入严格校验，**不认识的键一律拒绝**：

```jsonc
{
  "name": "xor-decode",            // 等于目录名，[a-z0-9][a-z0-9_-]{0,63}
  "kind": "decode",
  "version": "1",                  // 必填，1..64 字符；写进每个视图
  "description": "…",              // 可选，≤ 500 字符
  "match": {
    "host": ["127.0.0.1", "*.example.test"],   // 必填，1..32 个；* 匹配任意字符（含 .），只比 hostname
    "path": ["/s42/api/*"],                     // 可选，默认 ["/**"]；* 不跨 /，** 跨；只比 pathname，不含 query
    "contentTypes": ["text/plain"],             // 可选，默认 ["*/*"]；type/subtype、type/*、*/*，不带参数
    "direction": "both"                         // response（默认）| request | both
  },
  "command": ["bun", "./decode.ts"], // argv；argv[0] 为目录内的 ./文件、绝对路径或 PATH 上的程序名（uv、python3、bun）；其余 ./ ../ 参数必须留在目录内；工作目录是插件目录
  "timeoutMs": 5000,               // 可选，每次调用的硬超时，100..60000，默认 5000
  "maxBytes": 1048576              // 可选，送去解码的正文与解出的明文上限，1..32 MiB，默认 8 MiB
}
```

同目录可以有 `config.json`（密钥等）：tabcap 从不读它，它也不会进任何包；插件自己读（工作目录、环境变量 `TABCAP_PLUGIN_DIR`）。插件进程的环境只有 PATH、HOME、LANG、`TABCAP_PLUGIN_DIR`、`TABCAP_DECODE_PROTOCOL`、Windows 基本变量与 uv 的缓存变量（`UV_*`、`XDG_CACHE_HOME` 等，让 `uv run` 找到同一份缓存），没有任何 `TABCAP_*` 设置。内容类型取：请求方向用请求的 `content-type` 头，响应方向用 CDP `mimeType`，没有再用 `content-type` 头。

**协议 `tabcap-decode/1`**（一行一个请求，一行一个回答，按顺序；一个插件同一时刻只有一个调用在途）：

```jsonc
// tabcap → 插件
{"id":1,"op":"decode","direction":"response",
 "request":{"id":"r-12","url":"http://127.0.0.1:4310/s42/api/items","method":"GET","headers":{"x-auth":"…"}},
 "response":{"status":200,"headers":{"content-type":"text/plain; charset=utf-8","x-enc":"xor"}},   // 只在 response 方向
 "body":{"encoding":"base64","data":"…","mime":"text/plain"}}
// 插件 → tabcap
{"id":1,"ok":true,"mime":"application/json","body":{"encoding":"utf8","data":"{…}"},"note":"可选"}
{"id":1,"ok":false,"error":"为什么解不了"}
{"id":1,"declined":true}     // 不是我的正文：不写视图，也不算失败（0.6-T）
```

- `request.id`：录制时为 `null`（事件写入时才分配 `r-N`，解码在写入之前），`bundle decode` 时为 `r-N`。
- `headers`：录到的头，去掉 `cookie`、`set-cookie`、`authorization`、`proxy-authorization`，值过已知秘密值替换。正文原样（base64）。
- 回答 `body.encoding` 为 `utf8` 或 `base64`；`mime` 可选（不是可打印 ASCII 或超过 200 字符记 null）；`error` / `note` 截 500 字符并过秘密值替换后才写进包。
- **进程模型**：每个守护进程每个插件一个长驻进程（`bundle decode`、`replay check` 每次运行一个），首次用到时启动。超时、退出、非 JSON 行、超长行（`maxBytes` 的 4/3 加 64 KB）、id 对不上或缺 `ok` / `body` 都算一次**失败**，并杀掉进程，下次调用重新启动；`ok:false` 与 `declined` 是正常回答，不算失败。同一录制里累计 3 次失败，该插件在这次录制余下的时间里停用，录制器写一条 `note`：`{kind:"note", text:"decode plugin <name> disabled for this session: 3 failures, last: …", refs:[], plugin:"<name>"}`。插件的 stderr 读出后丢弃（可能打印密钥），不进日志、不进包。守护进程退出时杀掉所有插件进程。
- **放弃（declined，0.6-T）**：`decode()` 返回 `None` / `null` 表示「这不是我的正文」，在线路上是 `{"id":N,"declined":true}`（不带 `ok`；带 `ok:false` 的是真失败，进 `decoded` 视图并带 `error`）。放弃不写视图、不写 `decoded` 字段、不计入失败次数（不会触发停用）。Python 模板 runner 把 `plugin.decode()` 返回 `None`（且没有按 mitmproxy 方式给 `flow.response.content` 赋值）译成 `declined`；对「是我的但解坏了」的正文，插件抛异常，runner 回 `ok:false` 加错误文字。录制时与 `bundle decode` 同一规则。
- 多个插件都匹配同一正文时按名字顺序问，第一个 `ok:true` 的胜出；都放弃则这一侧没有视图；有放弃有失败则记第一个失败。正文超过 `maxBytes` 不送，记 `ok:false`。

**视图写在哪里**。录制器取到正文之后、写 `request` 事件之前调用插件，明文存成 `blobs/sha256/<hash>`，在事件的 `request` / `response` 两侧各自带 `decoded`（原正文、`postData`、`body` 都不变）：

```jsonc
"request":  { "headers": {…}, "postData": {"inline": "<原样密文>"},
              "decoded": {"by":"xor-decode","version":"1","direction":"request","mime":"application/json","blob":"sha256:…","bytes":44,"ok":true} },
"response": { …, "body": {"blob":"sha256:<密文>", …},
              "decoded": {"by":"xor-decode","version":"1","direction":"response","mime":"application/json","blob":"sha256:…","bytes":37,"ok":true} }
// 解不了：{"by","version","direction","mime":null,"blob":null,"bytes":null,"ok":false,"error":"…"}；插件回答带 note 时多一个 "note"
```

**录制中启用 / 停用（0.7-E，按实现定案，作者 2026-10-21 批量签收）**：录制器每个正文都重读已启用的解码插件（只在 `enabled.json` 或插件目录变了时重读，每次两个 stat），所以录制中 `plugin enable` 从下一个正文起生效、`plugin disable` 从下一个正文起停；之前写下的正文不补视图（录完后 `bundle decode` 补）。`tabcap status` 的 `recording.decodePlugins` 是这份录制到目前为止用过的插件（开始时启用的加上之后启用过的）。以前插件表在 `net start` 时定下，录制中启用的插件对这份录制无效【实测：上手验收 B1；v06b 新增一条：录制中 enable、reload 后出视图，之前的正文没有】。

没有插件匹配的一侧没有 `decoded` 字段。`net list` 的索引项带响应视图的 `decoded:{by, version, mime, blob, bytes}`；`net show` 两侧各列 `decoded`（by、version、ok、mime、bytes、path / blob 或 error）。

**离线补视图** `tabcap bundle decode <bundle> [--plugin <name>]`：不带 `--plugin` 用所有已启用的解码插件；带 `--plugin` 只用它（必须装着且清单有效；点名即同意，可以没启用）。只处理已 `finished` 的包（录制中或中断的拒绝，`conflict`）。**不改 `events.jsonl`，也不改 `manifest.json`**（§1 只追加是证据原则：录完的包事后不变，哪怕只是加字段；作者裁决 10-16）：视图追加到包根目录的旁路文件 `decoded.jsonl`，一行一个 `{seq, request:"r-N", direction, decoded:{…与内联相同的形状…}, at}`（`seq` 是旁路文件自己的行号序，从 1 起；`at` 为 epoch 毫秒），只追加，每行一次 `O_APPEND` 写入并 fsync（逐行原子；中断留下的半行读者跳过并报 `bad-sidecar`）。读者（`BundleReader`，以及 `net show` / `net body` 读单条事件时）把旁路文件叠加到请求事件上：同一 (request, direction) 以文件里最后一行为准，且盖过录制时写在事件里的视图；所以 `net body`、`find`、`where`、`deps`、`recon`、`replay check` 看到的与录制时写入的完全一样。`bundle info` 报 `decodedSidecar:true|false`（manifest 在结束后不可变，由读者看文件判定）。规则（以读者当前看到的视图为准）：没有被选中插件匹配的一侧不动，匹配的插件都放弃（`declined`）的一侧也不动（不写视图，不是失败）；与当前视图相同（by、version、ok、blob、mime、error）不再追加（`unchanged`），所以重跑不追加任何行；新的或不同的 `ok` 视图追加；失败从不覆盖已有的 `ok` 视图（`kept`，不追加）。新视图的明文 blob 照常进 `blobs/`（按内容寻址，只增不改）。回答：`{bundle, requests, decoded, failed, declined, declinedBy:{<插件名>:n}, kept, unchanged, appended, rows:[{request, direction, by, ok, mime, bytes, error?, kept?}], truncated, plugins:[{name, version}], disabled:[{plugin, reason}]}`（`declined` 是所有匹配插件都放弃的侧数，`declinedBy` 是每个插件放弃的次数，一侧被一个插件放弃、被另一个解出时只计入后者的 `declinedBy`；`rows` 最多 200 行，列追加的与 kept 的，放弃的不列）。离线没有会话，停用的插件列在 `disabled`，不写 `note`。HAR 导出与 `bundle redact` 读的是叠加后的事件：脱敏副本里视图内联在事件中（副本是新写的包）。

**读视图的命令**（`src/analyze/views.ts`）：视图 `ok` 且 blob 在，就以明文代替原正文，决定链第一步是 `plugin:<name>`（与 HAR 导入的线上解压步骤一样是前缀），后面照常走内置步骤。

- `find`：先搜视图；视图没有命中时再搜原正文（这时不判「像加密」）；`searched.decoders` 以 `plugin:<name>` 计数视图。
- `where`：有视图的响应只读视图，候选的 `chain` 以 `plugin:<name>` 开头。
- `deps`：有视图的请求体从明文取输入（JSON 叶子 / 表单字段），有视图的响应从明文找来源（`decode` 以 `plugin:<name>` 开头，`--write-findings` 的分级仍为【推断】，因为不是原字节上的 JSON 叶子）。旧包里「`Authorization` 追到更早请求的同名头」的环，在 token 响应可解码时消失（s42：`x-auth` 的主来源是 token 响应的 `$.token`）。
- `recon`：通道的 `decode` 列出插件步骤（排在内置步骤前）；通道的 `body` 分类仍按原正文。
- `replay check`：录到的响应有视图、且该插件在本机已启用时，用同一个插件解码收到的回答，比较两份明文（行的 `notes` 写 `body compared as decoded by <name> (plugin:<name>)`）；回答解不了或插件不可用时比较原字节，并在 `notes` 说明原因。`replay serve` 默认仍按原字节匹配；按明文匹配与按明文比较由回放键规则的 `body:"decoded"` / `compare:"status+decoded-body"` 打开（0.6-C，§31）。
- `net body r-N`：有视图时默认给视图（信封 `view:"decoded"`、`decoded:{by, version, mime}`，`mime` 是视图的），`--raw` 给原正文（`view:"raw"`），`--decoded` 在没有视图时报 `not-found`，两个一起报 `usage`；没有视图的请求输出不变。视图按 UTF-8 解码、照常过秘密值替换。

**脱敏**：`bundle redact` / HAR 导出把视图 blob 当作该 `mime` 的正文同样脱敏，`error` / `note` 过文本替换。HAR 1.2 没有放视图的位置，HAR 里只有原正文。

**Python runner 模板**（`templates/plugins/decode-python/`，随发布包和 npm 主包一起带（0.6-T；全局安装后在 `$(npm root -g)/tabcap/templates/plugins/decode-python/`），用户整个目录拷到 `plugins/<name>/` 后改 `manifest.json` 的 `name` 与 `match`）：`manifest.json`（`command` 为 `["uv","run","--project",".","runner.py"]`；不用 uv 时改成 `["python3","runner.py"]`，两者都在插件目录里运行）、`pyproject.toml`（默认无依赖，`plugin.py` 要用的库写进 `dependencies`，`uv run` 首次启动时装进本目录的 `.venv`）、`runner.py`（读 JSON 行、解 base64、调用 `plugin.decode(flow)`）、示例 `plugin.py`（s42 的 XOR，密钥从同目录 `config.json` 读；`config.example.json` 是样板）。`flow` 仿 mitmproxy addon 的形状：`flow.request.url / method / headers / content`、`flow.response.status_code / headers / content`（content 是 bytes；问请求体时 `flow.response` 为 None，问响应体时 `flow.request.content` 为 None），`headers` 不分大小写、`get_all()` 取多值，`.text` 可读可写。`decode()` 返回 bytes / str 或 None（None = 放弃，见上）；也可以像 mitmproxy 那样直接给 `flow.response.content`（或 `.text`）赋值，runner 认赋值后的内容。`plugin.MIME` 可选，没有就按内容猜 JSON / 文本。`plugin.py` 里的 `print()` 进 stderr（被丢弃），不会弄坏协议。

**0.6-V（10-17，作者定；隔壁项目两轮真实站点之后）**：

- **预检与空正文不送插件**：CORS 预检（`OPTIONS`，且 initiator 类型是 `preflight` 或带 `access-control-request-method` 头；与 0.6-S fixtures、0.6-U usage 同一条规则，`isPreflightOf`）整条交换的两侧都不送；字节数为 0 的一侧不送。录制时与 `bundle decode` 同一规则（`decodeSkip`）：不写视图、不算放弃、不算失败。`bundle decode` 的回答多 `skipped:{preflight, empty}`（`preflight` 按请求计，`empty` 按侧计）。
- **放弃覆盖同一插件的旧失败**：旧 runner 把「返回 None」记成 `ok:false` 视图；新 runner 回 `declined` 不写视图，旧失败就一直显示。现在 `bundle decode` 里，一侧被某插件放弃、而这一侧当前的视图（内联或旁路文件里胜出的那行）正是**同一插件**的 `ok:false` 视图时，追加一行放弃行 `{by, version, direction, mime:null, blob:null, bytes:null, ok:false, declined:true, error:"declined"}`（`version` 是这次放弃的插件版本）。读者（`latestViews` / `overlayEvent`，`BundleReader`、`net show` / `net body`、`find` 等都经过它）把放弃行当作「没有视图」：它排在一切视图之下（rank −1），只压住同一插件的失败（内联的或旁路文件里更早的），别的插件的失败与任何 `ok` 视图不受影响；之后再有任何视图行（失败也算）都盖过它。回答多 `superseded`（追加的放弃行数，也计入 `appended`），`rows` 列出这些行（`error:"declined"`、`superseded:true`）。再跑一次：这一侧已无视图，不再追加。别的插件放弃不动这一侧。`--text` 头行多「N superseded」与「N preflight(s) and N empty bod(ies) not offered」。
- `bundle decode` 的命令说明（`tabcap schema`）提到 declined / superseded / 不送预检与空正文（0.6-T 为了不动快照没写；作者接受快照变化）。

【实测 10-17：`test/unit/decode-plugins.test.ts` 的 0.6-V 五条（`decodeSkip`、录制路径、`bundle decode` 的 `skipped`、失败 → 放弃 → 无视图 / `appended 1` / `superseded 1` / 重跑 0、读者的 rank 规则）；e2e `v06b` 5/5 未受影响】

**脚手架 `tabcap plugin init --kind decode [<dir>] [--name <n>] [--force]`**（0.7-D，按实现定案，作者 2026-10-21 批量签收）：模板五个文件在构建时用 `import … with { type: "text" }` 嵌进二进制（`src/cli/plugin-init.ts`），发布包、npm、源码三种装法都能用，不必知道模板落在哪；`templates/plugins/decode-python/` 仍是源，单测断言嵌入的文本与磁盘上的文件逐字节相同。插件只从 `<config>/plugins/<name>/`（真目录，不认符号链接，目录名等于 `name`）发现，所以只给 `--name` 时直接写到那里；给了 `<dir>` 就写到 `<dir>`（相对调用者的工作目录），`name` 默认取目录名，不在插件目录里时回答的 `next` 先说把目录挪过去。写 `manifest.json`（只把 `name` 换成插件名，其余与模板逐字相同）、`plugin.py`、`runner.py`、`pyproject.toml`、`config.example.json`；`config.json` 只在不存在时从样板建（0600），**任何时候都不覆盖**。目录非空时拒绝（`conflict`），`--force` 改写五个模板文件、不碰 `config.json` 与其它文件；新建的目录 0700。回答 `{name, kind:"decode", dir, installed, files, kept, next}`：`installed` 表示已在插件目录，`files` 是本次写的文件，`kept` 是保留未动的（`config.json`），`next` 两步：改 `plugin.py`、`config.json` 与 `manifest.json` 的 `match`（模板匹配的是靶场 `127.0.0.1` `/s42/api/*`），然后 `tabcap plugin enable <name>`。`--kind` 必填，目前只认 `decode`（挑战处理程序没有模板），其它值报 `usage`。装上不等于启用，`plugin init` 不启用。【实测 10-17：`test/unit/plugin-init.test.ts` 7/7，含经插件注册表 `listPlugins` / `setEnabled` / `decodePlugins` 加载、用 `uv run` 跑生成的插件解 s42 正文；`bun run build` 后把 `dist/tabcap` 拷到仓库外运行 `plugin init`，五个文件与模板相同（`manifest.json` 只差 `name`），`plugin list` 看到它且无错误】

**靶场**：s42（`docs/05`），插件 `test/e2e/plugins/xor-decode/`（Bun 脚本，密钥在它自己的 `config.json`）。【实测 10-16，本机 CfT 155：`test/e2e/v06b.e2e.test.ts` 5/5；`test/unit/decode-*.test.ts`，含 `uv run` 跑 Python runner】

## 29. 0.6-J 点击落点（10-16 作者定设计；字段按实现定案，作者 2026-10-21 批量签收）

来自作者另一个项目的真实站点试用（10-16）：layui、antd、Element UI 上 DOM `click` 无障碍元素返回成功却什么都没发生，处理程序在子元素上（`lay-event` 的 span、内层按钮）或只认可信事件。0.6-D 的 `effect:"none"` 只能事后说没反应，这一格让点击落对地方。不加事件 kind，录制格式不变；只读，不改页面。

- **看什么**：默认 `click <ref>` 在点之前看目标所在文档：目标自己与往上至多 3 层祖先的 click / mousedown / pointerdown / touchstart 监听器（`DOMDebugger.getEventListeners`；冒泡管得到祖先）；目标的后代（深度 ≤ 4、至多 64 个、广度优先）的同样四种监听器与框架标记：`lay-event`、`onclick`、`role=button`、`href`、名字含 click / action / event / toggle / handler / command / trigger 的 `data-*`、元素自己引入的 `cursor:pointer`（父元素的计算值不是 pointer；继承来的不算，否则 pointer 元素的每个子元素都会被标上）。没有盒子（`display:none`、`visibility:hidden`、宽或高为 0）的后代不算候选。标记、文字、选择器在 tabcap 的隔离世界里读；监听器只能经主世界对象读【实测 spike 10-16 CfT 155：隔离世界的 objectId 调 `getEventListeners` 对有主世界监听器的节点返回空表】，用 `DOM.resolveNode`（不带 context，不跑页面脚本）取主世界对象。
- **判定表**：(a) 目标或祖先在监听 → 照旧点目标，输出不变；(b) 否则恰好一个后代在监听或带标记 → DOM 点击落到它上面（`el.click()` 没有坐标，「中心」只对 `--trusted` 有意义），输出加 `target: {ref, landedOn: {tag, text, selector}, reason: "descendant-listener"}`：`ref` 是给的那个 ref，`selector` 从最近的带 id 祖先（或 `body`）起写成 `tag.class:nth-of-type(k)` 链，至多 300 字符，`text` 是 `innerText` 的前 80 字符；(c) 好几个 → 照旧点目标，输出加 `candidates: [{ref, tag, text, selector, by}]`，`ref` 是铸给每个候选的 DOM 支撑 ref（0.6-D，同表同失效），`by` 是 `listener:<type>` 与标记名；(d) 哪儿都没有（框架在根上委托，React / Vue）→ 不变。`reason` 只有 `descendant-listener` 一个值，只靠标记选中的后代也用它。
- **`--trusted`** 走自己的路径但用同一个落点：(b) 时滚动、绘制确认、遮挡检查、指针终点、投递探针都对那个后代，`at` 是它的内容盒中心。`--dbl-click` 同理。`effect` 观察仍挂在原目标的文档上。
- **`snapshot --interactive`**：交互视图里每个带 DOM 节点的控件（无障碍交互角色）跑同一判定，(b) 的在行尾加 `landing="child"`；(c) 不标（点击不会落到子元素上）。每个文档一次 `getEventListeners {depth:-1}` 加一次页面调用；每文档至多检查 300 个控件，监听元素超过 2000 个的文档整份不标。默认（非 `--interactive`）快照不检查。
- 检查本身出错（页面脚本异常、节点在中途被换掉等）只记日志，点击照旧点目标、快照照旧不标；不加新的错误码。

## 30. 0.6-H 账号使用证据 `bundle info --usage`（10-16 作者定设计；字段与下列细节按实现定案，作者 2026-10-21 批量签收）

作者的红线要求每次运行都有证据：每个账号登录几次、每个主机多少请求、最短间隔、空正文与业务错误码。以前靠手数。`tabcap bundle info <bundle> --usage [--text] [--business-code '<$.路径>=<ok 值>']... [--actor page|fetch|evaluate|other] [--all-hosts]` 离线读包（不连守护进程、不发请求），输出 `tabcap-usage/0`；不带 `--usage` 的 `bundle info` 不变。`--text`、`--business-code`、`--actor`、`--all-hosts` 只能和 `--usage` 同用，否则 `usage` 错误；`--actor` 的值不是这四个之一也是 `usage`。**只有计数与名字，不含任何值**（不写 URL 路径、头值、正文、cookie、账号以外的凭据）。

```jsonc
{ "schema": "tabcap-usage/0", "bundle": "<目录>",
  "session": { "name", "site", "account" },               // 取自 manifest.session
  "logins": { "attempts": 2, "byAccount": { "alice": 1, "bob": 1 },
              "guardEvents": [ { "seq", "event", "site", "account", "rule", "decision", "reason", "request" } ] },
  "actors": { "page": 5, "fetch": 3, "evaluate": 0, "other": 0 },   // 0.6-S：列出的行按 actor 合计
  "filter": { "actor": null, "allHosts": false },                    // 0.6-S：--actor / --all-hosts
  "hosts": [ { "host": "shop.example.test", "actor": "fetch", "requests", "byMethod": { "GET": 3 }, "firstMono", "lastMono",
               "minIntervalMs", "meanIntervalMs", "maxBurst1s", "statuses": { "200": 5 },
               "emptyBodies", "preflights", "businessErrors", "bytesIn" } ],
  "skipped": { "loopback": { "hosts": ["127.0.0.1:4310"], "requests": 14 }, "schemes": { "data": 3 } },   // 0.6-S
  "stops": [ { "kind": "fetch-stop", "request": "r-9", "rule": "empty-body" } ],
  "windows": [ { "from": 1760500200000, "to": 1760500800000, "requests": 8 } ],
  "businessRules": ["$.code=0"], "note": "…" }
```

- **登录**：`guard` 事件里 `event:"budget"`、`detail.rule:"login-limit"`、`detail.decision` 为 `allowed` 或 `confirmed` 的算一次登录尝试（被 `refused` 的不算，因为没有碰页面）；`byAccount` 按事件的 `account`（无则 `(none)`）。`guardEvents` 列出包里全部 `guard` 事件的名字字段（`rule` 取事件的或 `detail` 里的，`decision`、`reason`、`request` 同），不含 `detail` 其余内容。
- **主机**：每条 `request` 事件一次，按 URL 的 `host:port` 与 actor（下一条）分行（重定向的每一跳、CORS 预检、favicon 都算），按主机的请求总数降序，同一主机内按 page、fetch、evaluate、other 排。开始时刻取 `timing.start`（CDP 单调毫秒），缺失时取事件的 `mono`，两者都没有的计入 `requests` 但不进间隔统计。`minIntervalMs` / `meanIntervalMs` 是同一行（同主机、同 actor）按开始时刻排序后相邻两条的间隔（均值 = (最后 − 最先) ÷ (n − 1)，保留三位小数；少于两条为 `null`）；`maxBurst1s` 是任意 1000 ms 窗口 `[t, t+1000)` 内同一行的最多请求数；`firstMono` / `lastMono` 是最早 / 最晚的开始时刻。**间隔统计不含 CORS 预检（0.6-U，来自真实项目复测 10-17：`fetch` 行的最短间隔 0.2 ms 是预检与它的请求之间的距离）**：`minIntervalMs`、`meanIntervalMs`（n 是非预检请求数）、`maxBurst1s` 只按该行的非预检请求算；预检照旧计入 `requests`、`byMethod`、`preflights`，`firstMono` / `lastMono` 仍跨该行全部请求（含预检）。只有预检的行间隔为 `null`、`maxBurst1s` 为 0。`statuses` 的键是状态码，没有响应的记 `failed`（`outcome:"failed"`）、`incomplete` 或 `none`。`bytesIn` 是已存正文的字节数之和（解码后，`response.body.size`），没存正文的算 0。
- **actor**（0.6-S，按包里的字段，先到先得）：`fetch` = 请求带 `fetchId`（`tabcap fetch` 发出的，含它的重定向跳与预检，§26）；`evaluate` = 请求的 `cmd` 指向一个 `input.action` 为 `evaluate` 的 `cmd` 开始事件（`tabcap evaluate` 的命令窗口里写的）；`other` = 没有 `tab`，或 `cmd` 指向守护进程自己发起的命令（开始事件 `actor:"system"`，如插件钩子）；其余是 `page`（页面自己的请求，包括 `navigate` / `click` / `fill` 窗口里的）。【推断】`evaluate` 按命令窗口归属：窗口里页面自己的定时请求也算 `evaluate`；`fetch` 窗口里页面自己的请求没有 `fetchId`，仍算 `page`。`--actor <名>` 只列这个 actor 的行（`actors` 里其他为 0，窗口也只计它）。
- **不进表的**（0.6-S）：没有 host 的 URL（`data:`、`blob:`、`about:`）不成行，按 scheme 计入 `skipped.schemes`；回环主机（`127.0.0.0/8`、`localhost`、`*.localhost`、`::1`，与 `replay serve` 的回环判断同一个）默认不列，主机名与请求数计入 `skipped.loopback`，`--all-hosts` 时照常成行（`skipped.loopback` 为空）。
- **空正文**：有响应、状态码不是 3xx、不是 CORS 预检，且（没有正文并且 `bodyMissing` 为空或 `no-content`，或正文 0 字节，或 ≤ 64 KiB 的文本正文去掉空白后为空）。其他没存正文的原因（过大、被导航、被驱逐…）是「不知道」，不算空；被 `net start --bodies` 跳过的（`response.body:{skipped}`，0.6-I）同样不算空。与 `fetch` 的 `empty-body` 停手规则一致。CORS 预检（`OPTIONS`，CDP 发起者类型 `preflight`，或带 `access-control-request-method` 头）本来就没有正文，单独计入 `preflights`（0.6-S；以前算进了 `emptyBodies`）。
- **业务错误码**：`--business-code '$.code=0'` 可重复，路径写法同 `--stop-on json:`（`$`、`.键`、`[下标]`），`=` 之后能按 JSON 解析的按 JSON 比（`0` 是数字），否则按字符串。只判断能解析成 JSON 对象或数组的响应正文（≤ 8 MiB）：路径上的值与 ok 值不相等就算错误，**路径上没有值也算错误**（「其余一律算错」）；多条规则时，任一条不满足即算该响应一次错误。HTML、二进制、空正文不判断。
- **停手**：`guard` 的 `breaker` 事件各一条：`kind` 是事件的 `reason`（`fetch-stop`、或 §4.2 的其他熔断原因，缺则 `breaker`），`request` 是事件的 `request`，`rule` 是事件的 `rule`。`resume` 不算。
- **窗口**：列出的行里的每个请求（0.6-S：不含 `skipped` 的，`--actor` 时只含该 actor）的墙钟开始时刻（`ts − (mono − timing.start)`，缺失时取 `ts`）落入对齐到 UTC 整 10 分钟（600000 ms 的倍数）的窗口；只列有请求的窗口，按时间升序。
- **`--text`**：一屏文本表：先一行 `actors page n  fetch n  evaluate n  other n`，再每个主机 × actor 一行（主机、actor、请求数、最短 / 平均间隔、1 s 突发、空正文、预检、业务错误、字节），有不进表的就再一行 `skipped: loopback <n> request(s) on <主机…> (--all-hosts lists them); data: <n> (no host)`，随后是各行的方法与状态码分布、停手、窗口和 note，可直接贴进运行记录。`logins` 行的账号名照旧显示（§8.1 允许 agent 看账号名；隔壁项目试用者对 `--text` 里出现账号名有意见，按转述记在 NOTES，按实现定案，作者 2026-10-21 批量签收）。
- 退出：包缺失 `not-found`；包没收尾（录制中或中断）照常读，不报错（与 `bundle info` 一致）。

## 31. 0.6-C 回放键规则与夹具导出（10-16 作者定设计；字段按实现定案，作者 2026-10-21 批量签收）

作者定（来自真实项目试用：离线回放三个站点要手写三种匹配规则，一个要分开表单体和 JSON 体，一个要忽略易变的 `_t` 参数、先解密请求体再比；`replay serve` 只认 method + path + 排序 query + 正文 sha256，加密正文的站点一条都配不上）：一份规则文件，`replay serve`、`replay check` 与新命令 `bundle export fixtures` 共用；夹具的输出格式可插拔，项目里手写的离线回放脚本可以删掉。

**规则文件** `replay-rules.json`，schema `tabcap-replay-rules/0`，按不可信输入校验（不认识的键一律拒绝；文件 ≤ 1 MiB，≤ 256 条规则，每个列表 ≤ 64 项、每项 ≤ 200 字符）：

```jsonc
{
  "schema": "tabcap-replay-rules/0",          // 文件里必填；config.json 里可省
  "rules": [
    {
      "match": {                               // 都可省；省了就不按它筛
        "host": "127.0.0.1",                   // hostname 的 glob（* 任意字符，含 .）；带 : 时比 host:port；不分大小写
        "path": "/api/**",                     // pathname 的 glob：* 不跨 /，** 跨，? 一个字符；不含 query
        "method": "POST"                       // 不分大小写
      },
      "key": {
        "ignoreQuery": ["t", "nonce", "_*"],   // query 名或 glob（* 任意字符）；从键里去掉
        "caseInsensitiveQuery": true,          // query 的名和值都转小写再比（默认 false）
        "body": "json",                        // raw（默认）| form | json | decoded | none
        "ignoreBodyFields": ["$.ts", "$.items[*].at", "_t"],  // JSON 路径或名字（表单字段 / JSON 顶层键）
        "decodeWith": "xor-decode"             // 只配 body "decoded"：用哪个解码插件
      },
      "response": {
        "compare": "status+decoded-body",      // status | status+body（默认）| status+decoded-body
        "ignorePaths": ["$.serverTime"],       // 比较前从两边的 JSON 里去掉
        "decodeWith": "xor-decode"             // 只配 status+decoded-body
      },
      "prefer": "2xx"                          // 0.6-S：recorded（默认）| 2xx | latest，见下「回放优先级」
    }
  ]
}
```

- **选规则**：按顺序，第一条 `match` 全部符合（按录到的请求的 URL 与方法）的生效；都不符合用默认规则 `default`，等于 0.3-B 的行为（method + path + 排序 query + 正文字节的 sha256；比较 status + body，包括 0.6-B 的已启用插件自动解码）。没有任何规则时，`replay serve` / `check` 的匹配与比较与 0.6-B 完全一样，输出只多一个 `rules:{source:"none", rules:0}`（行与路由不多 `rule`，`x-tabcap-replay` 不变）。
- **规则的 id**：在输出里点名用，`rules[0]`（文件）、`sites.example.replay.rules[0]`、`replay.rules[1]`（config.json），都不符合时 `default`。
- **来源**：`--rules <file>` 给了就只用它；没给就读 `config.json` 的 `sites.<包的站点>.replay`（manifest `session.site`）再接 `replay`，两处都是 `{rules:[…]}`，站点的排在前面，所以站点规则优先、和站点放在一起。`bundle export har --rules` 只认 `--rules`，不读 config.json。
- **矛盾即报错**：`decodeWith` 不配 `body:"decoded"` / `compare:"status+decoded-body"`、`ignoreBodyFields` 配 `body:"raw"|"none"`、`ignorePaths` 配 `compare:"status"`、JSON 路径写错（`$` 后只认 `.名`、`.*`、`[n]`、`[*]`、`["带空格的名"]`；单写 `$` 表示整个正文，要整个不比用 `body:"none"`），都在开服务前报 `bad-input` 并指到 `rules[i].key.…`。

**回放优先级 `prefer`**（0.6-S；来源：隔壁项目 10-17 用 0.6.0 跑真实站点，同一个键先录到一次失败的尝试 403、后来才录到 200，`replay serve` 按录制顺序轮换，先吐 403，爬虫当场失败）：一个键录到多条时，哪几条拿来回答。

| `prefer` | 回答的录音 |
|---|---|
| `recorded`（默认） | 全部，按录制顺序轮换（0.3-B 起的行为，不变） |
| `2xx` | 只用状态码 200–299 的，按录制顺序轮换；这个键一条 2xx 都没有时用全部（同 `recorded`） |
| `latest` | 只用最后录到的一条 |

- 每个键取它的规则的 `prefer`（有规则时规则 id 在键里，一个键只有一条规则）；没有规则的键用默认规则，即 `recorded`。`replay serve --prefer <v>` / `replay check --prefer <v>` 对所有键覆盖规则里的值。
- `replay serve`：不回答的录音永远不会被吐出；命中头在 `prefer` 不是 `recorded` 时多 `;prefer=<v>`（`r-N;n=k[;rule=<id>];prefer=2xx`，`n=k` 在被选中的录音里数），日志行多 `prefer <v>`；启动输出多 `prefer`（`--prefer` 的值，没给为 `null`），`routes[]` 在 `prefer` 不是 `recorded` 时多 `prefer` 与 `served`（回答这个键的 `r-N`）。
- `replay check`：`prefer` 不是 `recorded` 的键只发、只比那些会被 `replay serve` 拿来回答的录音（键按 `serve` 不带 `--strict` / `--match-cookies`、请求的 Host 是录到的主机时的算法；多主机包里 Host 不是录到的主机时 `serve` 用不带 host 的键，两边可能不一致），其余列在 `notPreferred:[{id, prefer, servedBy:[r-N…]}]`，不发送；结果多 `prefer`（`--prefer` 的值或 `null`）；`--text` 多一行 `not preferred: …`。所以 `check --prefer 2xx` 对着 `serve --prefer 2xx` 应当零差异；不带 `--prefer` 的 `check` 照旧逐条发，会把那条 403 录音的请求也发一次（服务器用 200 回答，行为 `different`）。
- `bundle export fixtures`：没有 `--prefer`，按规则的 `prefer`（要让全部键都按 `2xx`，写一条只有 `prefer` 的规则 `{"prefer":"2xx"}`，它的 `match` 为空、命中一切）。**定案：只导出被选中的录音**（与 `serve` 回答的完全一致，按录制顺序），没被选中的列在回答与 `index.json` 的 `notPreferred:[{request, prefer, servedBy}]`；没有采用「全部导出、被选中的排在前面」，因为那样夹具集合与回放服务器的行为不一致。夹具编号 `<n>` 数的是写出的夹具（从 1 起连续）。
- 只录到一条的键不受影响。

**CORS 预检**（0.6-S）：预检 = `OPTIONS` 且（CDP 发起者类型 `preflight`，或带 `access-control-request-method` 请求头，后者覆盖 HAR 导入的包）。
- `bundle export fixtures` 默认不导出预检，列在 `skipped`（`reason:"preflight"`）；`--include-preflight` 照常导出。
- `replay serve` 的行为不变（这里只写明）：预检是普通的录音，键是 `OPTIONS` + path + 排序 query + 空正文的 sha256，不看 `access-control-request-*` / `origin` 头（除非 `--strict` 点名）。录到过的，一个同 path、同 query 的 `OPTIONS` 拿到录到的状态（通常 204）和录到的响应头（`access-control-allow-*` 原样；与其他录音一样去掉逐跳头，同源的 `location` 改成路径），没有正文；没录到的，`OPTIONS` 得到上面的 404 `no-match` JSON（浏览器的预检会因此失败；脚本客户端不发预检，不受影响）。`replay check` 照常逐条发预检录音并比较。

**规范化表**（键的两边、`check` 的两边都按同一条规则走）：

| `key.body` | 键里放什么 | 读不了时 |
|---|---|---|
| `raw` | 正文字节的 sha256（0.3-B） | — |
| `form` | 按 `application/x-www-form-urlencoded` 拆成对，去掉 `ignoreBodyFields` 里的名字，按名、值排序后重新编码（`password=…&user=…`）；字段顺序、`+` 与 `%20` 等写法不影响 | 不是 UTF-8：退回 raw，`fallback:"not-utf8"` |
| `json` | 规范 JSON：对象键排序、无空白，去掉命中的路径（连同其下全部）；裸名字只命中顶层键 | 不是 JSON：退回 raw，`fallback:"not-json"` |
| `decoded` | 解码视图的明文：视图 `mime` 是表单就按 form，否则能解析就按 json，再不然是明文字节的 sha256 | 没有明文：原正文 raw，`fallback:"not-decoded: …"` |
| `none` | 不放正文 | — |

query：`URLSearchParams` 解出的名值对，去掉 `ignoreQuery` 命中的名（`caseInsensitiveQuery` 时先转小写、glob 不分大小写），按名、值排序。录到的请求体没取到（`postDataMissing`）的仍匹配任意正文（0.3-B）。

**明文从哪来**（`body:"decoded"`、`compare:"status+decoded-body"`）：插件是规则的 `decodeWith`，没写就用录到的视图的 `decoded.by`。录的一侧：视图是这个插件的就用视图（录制时写的，或 `bundle decode` 旁路文件里的），否则用插件现场解录到的字节；对面（`serve` 收到的请求、`check` 收到的回答）用同一个插件现场解。规则点名即同意：插件只要装着、清单有效，**不必** `plugin enable`（和 `bundle decode --plugin` 一样）；插件自己的 `match`（host / path / content type）照样决定它收不收这个正文（`serve` 用录到的源拼 URL 去比 host）。插件进程每次运行一个，`replay serve` 退出时杀掉。

**`replay serve --rules <file> [--prefer <v>]`**：键 = method + path + 规范 query + 规范正文（+ 规则 id；多主机包仍带 host，`--strict` / `--match-cookies` 照旧）。收到的请求按它可能指的每个录到的主机（Host 头是录到的就只它，否则全部）各取一条规则去读，`decoded` 规则先把正文交给可能的插件解开。启动输出多 `rules:{source:"file"|"config"|"none", file?, site?, rules:n}`，`routes[]` 多 `rule`；写明哪些规则点名的插件没装、哪些录到的请求没有视图而按原字节作键。

- 命中：`x-tabcap-replay: r-N;n=k;rule=<id>`（没有规则时仍是 `r-N;n=k`）；被忽略但与这条录音不同的部分写在 `x-tabcap-replay-ignored: query=nonce,t;body=$.ts`（没有不同就没有这个头；名字里不可见的字符和 `%` `,` `;` 按百分号编码）。`replay check` 认带 `;rule=` 的头。
- 404：`request.rule` 是这条请求按哪条规则读的；每个候选多 `rule`，`differs.query` / `differs.body`（`fields` 是规范化后不同的表单名 / JSON 路径，`as` 是 form / json / raw，退回时带 `fallback`）按候选自己的规则比，`differs.ignored:{query?, body?}` 列出被忽略但不同的部分。没有规则（或候选用默认规则）时 404 与 0.3-B 完全一样。

**`replay check --rules <file> [--prefer <v>]`**：每行按录到的请求选规则（行多 `rule`）。`compare:"status"`：只比 status 和 `--headers` 选的头，正文不比（行 `notes` 写明，结果可为 `same`）；`status+body`：如前，`ignorePaths` 从两边 JSON 去掉后再逐路径比；`status+decoded-body`：两边都按上面的明文来源解开再比（`notes`：`body compared as decoded by <name> (plugin:<name>; rule <id>)`），哪一边解不开就不比正文，行为 `unverified`，`notes` 写原因（不退回比原字节）。`--headers` 仍按原样比。结果多 `rules:{source, file?, site?, rules}`。

**`tabcap bundle export fixtures <bundle> --out <dir> [--rules <file>] [--format json|<plugin>] [--no-redact] [--include-preflight]`**：可回放的每一条录到的交换（同 `replay serve`：有响应、状态 200–599、不是 WebSocket；其余列在 `skipped`）出一个夹具。`--out` 必须不存在或为空（不覆盖旧文件，`conflict`）；文件 0600，目录 0700。

```jsonc
// fixtures/<n>-<METHOD>-<path slug>.json   （n 从 1 起；slug 只留字母数字 . _ -，其余变 -，≤ 80 字符，空则 root）
{
  "schema": "tabcap-fixture/0",
  "key": {"method": "GET", "path": "/api/search", "query": "client=web&page=1&q=apple&sig=…&v=3",
          "body": "sha256:e3b0…"},            // form / json / decoded 时是规范文本（超过 64 KiB 写 sha256:<规范文本的哈希>），none 时 null
  "request": {"url": "…", "headers": {…}, "body": "…" | null, "bodyEncoding": "utf8" | "base64", "bodyMissing"?: "…"},
  "response": {"status": 200, "headers": {…},
               "body": "…", "bodyEncoding": "utf8"          // ≤ 64 KiB 的文本
               | "bodyFile": "bodies/<sha256>.bin"           // 二进制或更大
               | "body": null, "bodyMissing": "…",
               "decoded"?: {"by", "version", "mime", "body" | "bodyFile"}},   // 响应有 ok 的解码视图时
  "meta": {"request": "r-12", "rule": "rules[0]", "recordedAt": "2026-10-16T…Z", "keyBody": "raw" | "form" | "json" | "none", "keyFallback"?: "…"}
}
```

另写 `index.json`：`{schema:"tabcap-fixtures/0", bundle:<manifest id>, exported, redacted, rules:{…}, count, fixtures:[{file, request, method, path, query, status, rule}], skipped, notPreferred}`。回答：`{out, format, fixtures, files:[相对路径，最多 500], filesCount, index, rules, redacted, saltFile, skipped, notPreferred, failed:[{request, error}], plugin?, complete, warnings}`。`skipped` 里 0.6-S 起多一种原因 `preflight`（见上「CORS 预检」）；`notPreferred` 见上「回放优先级」。**`skipped` 汇总（0.6-U，来自真实项目复测 10-17：真实包里一百多行 websocket）**：回答里的 `skipped` 改为按原因计数 `{"websocket": 113, "preflight": 26, …}`，另有 `skippedExamples: {<原因>: [r-N…]}`，每个原因至多 3 个请求 id（按录制顺序的前几个）；`index.json` 的 `skipped` 仍是逐条 `[{id, reason}]`（文件是留档，不进屏幕）。这个命令没有 `--text`，屏幕上看的就是回答 JSON。

- **脱敏**：默认先按 HAR 导出的规则（§8）脱敏整个包再读，**键也从脱敏后的包算**（否则登录体的密码会出现在 `key.body` 里），盐写 `<bundle>/exports/fixtures-<时间>.salt`；解码视图同样脱敏（视图里 `token` 等字段名命中就打码）。`--no-redact` 保留录到的值，和 HAR 导出一样，登录体连密码原样进夹具，用的人自己负责。

**夹具插件**（`kind:"fixture"`，`src/daemon/hooks/fixture.ts`）：团队自己的测试框架格式是插件的事，不是 tabcap 的事。同一插件目录（§18、§28）；`--format <name>` 点名即同意，不必启用；`tabcap plugin list` 的 `kind` 为 `fixture`。清单按不可信输入严格校验：

```jsonc
{"name": "fixture-harness", "kind": "fixture", "version": "1", "description": "…",
 "command": ["bun", "./fixture.ts"],   // 规则同解码插件
 "timeoutMs": 5000,                    // 每个夹具的硬超时，100..60000
 "maxBytes": 1048576}                  // 一个回答里文件解码后的总字节上限，1..32 MiB，默认 8 MiB
```

协议 `tabcap-fixture/1`，与解码插件同样的 JSON 行（一行一个请求、一行一个回答、按顺序；每次运行一个长驻进程；环境同解码插件，协议变量为 `TABCAP_FIXTURE_PROTOCOL`）：

```jsonc
// tabcap → 插件
{"id":1,"op":"fixture","fixture":{…上面 json 格式的一个夹具…}}
// 插件 → tabcap
{"id":1,"files":[{"path":"tests/test_search.py","encoding":"utf8","data":"…"}]}
{"id":1,"ok":false,"error":"…"}
```

`path` 相对 `--out`：不许绝对路径、`..`、`.`、空段、反斜杠、换行，≤ 255 字符；一个回答 ≤ 64 个文件；本次运行已写过的路径再写记为该夹具失败。超时、退出、非 JSON 行、id 不对、文件不合规算一次失败并重启进程；3 次失败后插件在这次运行里停用，余下的夹具都进 `failed`。插件格式时只写插件给的文件（和二进制正文的 `bodies/`），不写 `fixtures/` 与 `index.json`。

**`bundle export har --rules <file>`**：只把每条请求所符合规则的 `ignoreQuery` 参数从 `request.url` 与 `queryString` 里去掉，让按 HAR 回放的工具键对得上；HAR 别的一个字节都不变。回答多 `rules`。

`replay export-python` 的链目标（0.7-E）：`--request r-N` 与 `analyze chain --request` 同义；`verify()` 从答复里取链上推得出的输入（§36）。

0.6-S 的 `prefer` 与预检只有单测（`test/unit/offline06s.test.ts`：一个键先 403 后 200、一个键两条 200、一个键只有 500 / 502、一条预检；`serve` 的头与路由、`check` 的 `notPreferred`、夹具的选择与编号、预检的跳过与 `serve` 的回答），没有加靶场页【实测 10-17，单测】。

**靶场**：不加新页，复用 s06（t / nonce / sig）、s07（表单登录）、s42（加密正文，`xor-decode`）；夹具插件 `test/e2e/plugins/fixture-harness/`（Bun 脚本，每个夹具出一个 `cases/<r-N>.json`）。【实测 10-16，本机 CfT：`test/e2e/v06c.e2e.test.ts` 7/7；`test/unit/replay-rules.test.ts`、`test/unit/fixtures-export.test.ts`】

## 32. 0.6-G 响应形状与 schema 漂移（10-16 作者定设计；字段与下列细节按实现定案，作者 2026-10-21 批量签收）

作者定：`tabcap analyze shape <bundle> [--request r-N | --template "<METHOD> <路径模板>"] [--types <类型,…>|all] [--text] [--write]` 按端点推断响应形状（类型树，带出现次数）与请求形状（query 名、请求体字段），schema `tabcap-shape/0`，`--write` 存进包的 `exports/shape.json`；`tabcap analyze schema-diff <旧包> <新包> [--template …] [--types …] [--text] [--write]` 按端点比较两份形状，有漂移时退出码 1（可放 cron）。输出里从不出现值：只有类型、格式、字段名，和不超过 8 个、字段名不敏感（`bundle redact` 的名字规则）的枚举字面量。只读，不发请求，不写事件。

- **类型**（0.6-S；来源：隔壁项目 10-17 的一个包列出 116 个端点，大多是带 `?v=` 缓存参数的 css / png / js）：默认只推断「像 API 的」交换：资源类型 `xhr`、`fetch`、`document`，加上任何类型里响应 content type 是 JSON 的（`application/json`、`+json`、ndjson / jsonl，参数不论；`recon` 的 JSON 判断）。`--types a,b` 只推断这几个类型，**不再**加 JSON 那条（所以 `--types xhr,fetch` 与 `bundle export har --types xhr,fetch` 的集合一致）；`--types all` 是 0.6-G 的行为（全部交换）。类型名必须是 §5.1 的资源类型之一，否则 `usage`。`--request r-N` 不受类型过滤。被过滤掉的交换不进 `endpoints`、也不进 `unshaped`，只计入 `excluded.types`；`filter` 多 `types`（类型列表或 `"all"`）与 `json`（是否加 JSON 那条）。`schema-diff --types` 对两边用同一个过滤，结果的 `filter` 同样多这两项。`--text` 头行写明用的类型与过滤掉几条。
- **端点**：方法 + `recon` 算的路径模板（纯数字、uuid、长十六进制段 → `{id}`，丢掉 query），一个端点合并它录到的全部交换。`key` 写作 `GET /api/list`。`--request r-N` 只用这一条交换推断（列出的仍是它所在端点的 key）；`--template` 只看这一个端点（方法大小写不论，路径模板逐字相等；找不到报 `not-found`）。两者互斥（`usage`）。什么都推不出的端点（脚本、图片、没有 query 的 HTML 页）不进 `endpoints`，只在 `unshaped` 里列 key。
- **正文**：有 `ok` 的解码视图（§28）用视图的明文，`decode` 以 `plugin:<name>` 开头；否则用录到的字节，沿解码链找到 JSON 文档：gzip / deflate（按魔数）、UTF-8、JSON 对象或数组、jsonp（`jsonp`,`json`）、ndjson / sse（每行 / 每个事件一个元素，按数组推断）、严格 base64（再走一遍），链长 ≤ 4。HAR 导入包的线上解压照 `find` 记前缀步骤。二进制、超过 32 MiB、blob 缺失或走完链也不是 JSON 的响应计入 `notJson`。请求体同理（`request.decoded` 优先），不是 JSON 时按表单字段（`a=1&b=2`）当作字符串对象。JSON 里的字符串字段即使本身是 JSON 文本也按 `string` 记（不走 `json-string`）。
- **类型树** `Shape`：`{kind:"object"|"array"|"string"|"number"|"boolean"|"null"|"union", fields?:{<名字>:{type:Shape, optional, samples}}, items?:Shape, enum?:[…], format?, variants?:[Shape…]}`。`samples` 是该字段出现的次数，`optional` = 出现次数少于其所在对象的样本数。同一位置见过多种 kind 时为 `union`，`variants` 每种 kind 一个，顺序固定为 object、array、string、number、boolean、null；`null` 与别的 kind 一起出现也是 union（`string|null`）。只见过空数组时没有 `items`。数字：全是整数为 `format:"int"`，否则 `"float"`。字符串的 `format`：`datetime`（ISO 8601，`T` 或空格分隔，秒、小数、时区可省）、`date`（`YYYY-MM-DD`）、`int` / `float`（十进制数字串）、`id`（uuid，或 ≥ 16 位且含数字的十六进制，与 `recon` 的 `{id}` 同规则）、`email`、`url`（`http(s)://`），按这个顺序取第一个；每个样本都是同一格式才写 `format`。
- **枚举**（`enum`，排序后的字面量）只在字符串节点上、且同时满足时给出：没有 `format`；不同值 ≤ 8；每个值是短词（字母、数字、`_ . : -`，≤ 64 字符，无空白）；样本数 ≥ 不同值数 × 2（小样本里的自由值不算枚举）；所在字段名不被 `isSensitiveName` 判为敏感（`token`、`session`、`sid`、`auth`、`pwd`…；数组元素沿用数组字段的名字）。
- **上限**：每个端点 ≤ 2000 个字段（query、请求体、响应合计，超出的新字段不再记，`capped.fields`）；深度 ≤ 32（更深的不展开，`capped.depth`）；每个数组只取前 200 个元素（`capped.items`）；前两种超限另写 `warnings`。
- **`tabcap-shape/0`**：`{schema, bundle, session, generatedAt, filter:{request, template, types, json}, limits:{fields:2000, depth:32, arrayItems:200, enum:8}, excluded:{types, incomplete}, endpoints:[{key, method, template, exchanges, requests:[r-N…≤10], status:[…], decode:[步骤名], request:{query:Shape|null, body:Shape|null}, response:Shape|null, samples:{query, body, response}, notJson, capped:{fields, depth, items}}], unshaped:[key…], warnings, written?}`。`query` 是一个 object，字段即参数名（值都是字符串，同名重复时为字符串数组）。`--write` 把同一个对象（不含 `written`）写到 `<bundle>/exports/shape.json`，0600、`exports/` 0700，每次覆写；和侦查档案一样不参与分析，`bundle redact` 的副本不带。`--text` 每个端点一行头，然后一行一个位置：`  $.items[].price  string(float)[  optional][  enum a,b]`。
- **扁平路径**（比较与 `--text` 用）：响应从 `$` 起（`$.items[].name`；不是标识符的名字写成 `$["a b"]`，同 `find` 的 JSON 路径），query 参数为 `query:<名字>`，请求体从 `body:$` 起（与 `analyze deps` 的输入标签同形）。类型文字：`kind` 加可选 `(format)`，union 用 `|` 连接各 variant（`number(int)|null`）。
- **`schema-diff`**（schema `tabcap-schema-diff/0`）：两包都用上面的规则推断（带 `--template` 时只看这个端点，一边没有就是 new / gone，两边都没有报 `not-found`），按 key 配对。每个端点 `{key, method, template, verdict:"same"|"drift"|"new"|"gone", added:["<路径>:<类型>"…], removed:[…], changed:[{path, from, to}], optionalityChanged:[{path, from:"required"|"optional", to}], enumChanged:[{path, from:[…], to:[…]}]}`；`added` / `removed` 列出每一个新增 / 消失的位置（父节点新增时子节点也逐个列出），`changed` 是两边都有、类型文字不同（含 format 与 union 的变化），`enumChanged` 只在两边都有枚举且不同时报。五个列表任一非空即 `drift`。只在旧包 / 新包里的端点为 `gone` / `new`（不算漂移）；但端点在另一边录到了、只是什么都推不出（如 JSON 接口改回了 HTML 登录页）时，按空形状比较，是 `drift`（全部 removed / added）。另一边那个数组一个元素都没有时，数组下面的位置不比较（没有证据），写一条 `warnings`。顶层：`{schema, bundles:[{short, dir}], old:{dir, id, session, endpoints}, new:{…}, filter:{template, types, json}, drift, summary:{same, drift, new, gone}, endpoints:[…], warnings, written?}`（`bundles` 0.7-C 加，旧包在前，§2.1），旧包里的端点在前，新包独有的在后。有 `drift` 时 CLI 退出码 1，信封仍是 `ok:true`（比较本身成功了）；`new` / `gone` 不影响退出码。`--text` 一行一个变化：`drift GET /api/list added $.items[].name:string`、`… removed …`、`… changed <路径> <旧> -> <新>`、`… optionality <路径> required -> optional`、`… enum <路径> [a] -> [a,b]`、`new <key>`、`gone <key>`，末行 `schema-diff: <n> drift, <n> same, <n> new, <n> gone`。`--write` 把两边的形状各写进自己的 `exports/shape.json`。
- **HAR 往返的假漂移**（0.6-S 调查；来源：试用者把包按 `--types xhr,fetch` 导出 HAR 再导入，与原包 `schema-diff`，一个端点报了 query 的 optionality 变化）。本地合成包上复现【实测 10-17，`test/unit/offline06s.test.ts` 最后三条】：
  - HAR 往返本身不改 query：全类型、`--no-redact` 导出再导入，`schema-diff` 全部 `same`（含 `+`、空值、没有 `=` 的名、重复的名、百分号编码的值）。默认脱敏时，名字敏感的 query 值（`token` 等）变成占位符，`format` 丢失，报 `changed`（如 `query:token string(id) -> string`），不报 optionality。
  - 静态资源本身不会让一个 API 端点的 optionality 变：它们是别的端点（`GET /app.js`），旧版里表现为一堆 `gone` / `new` 的噪声；0.6-S 默认类型后不再出现。
  - optionality 的假漂移来自**两边的请求集合不同**：(a) 同一个端点（方法 + 模板）还有一条 `xhr` / `fetch` 以外类型的交换（如 `document` 导航到同一路径、query 少一个参数），HAR 按类型过滤后没有它 → `query:size optional -> required`；`schema-diff --types xhr,fetch` 两边同过滤后为 `same`。(b) 同一端点有一条 `outcome:"incomplete"` 的交换（被导航打断、SSE），§9.1 的 HAR 导出默认不导出 incomplete → 同样的 optionality 漂移，与类型无关。这两种都不是形状推断的错；(b) 怎么处理（形状默认不计没有响应的交换，或 HAR 导出加开关）待作者定，本格没改。试用者那个包是 (a) 还是 (b) 要看原包，本地无法判断。比较 HAR 导入包与原包时：两边用同一个 `--types`，并注意 incomplete 与脱敏占位符。
- **不计没有响应的交换（0.6-V，作者定上面 (b)）**：`outcome:"incomplete"` 的交换（没有响应：被导航打断、SSE 等）默认不推断形状，与 §9.1 HAR 导出默认不导出 incomplete 一致；计入 `excluded.incomplete`，`--types`（含 `all`）不改变这一条；`--request r-N` 仍不过滤。`excluded` 从数字改为 `{types, incomplete}`（未分发，不留兼容）。`--text` 头行另写「N without a response left out」。【实测 10-17：`test/unit/offline06s.test.ts` 里 (b) 那条——一个端点带一条 incomplete、按 `xhr,fetch` 导出 HAR 再导入——现在默认、`--types xhr,fetch`、`--types all` 三种都是 `same`】
- **靶场**：s06 加 `GET /api/list` 与变体 `?v=2`（`title` 改名 `name`、`price` 由小数字符串变数字、加 `currency`；`docs/05` s06）。【实测 10-16，本机 CfT 155：`test/e2e/v06g.e2e.test.ts` 3/3；`test/unit/shape.test.ts`】

## 33. 0.6-L 页面内解码·观察模式 `trace start --decode`（10-16 brief + 两处实测修正；字面与下列细节按实现定案，作者 2026-10-21 批量签收）

观察模式借页面的解密：站点把 API 响应体加密、靠页面自己的 JS 解出明文；解码插件（§28）要密钥与算法，页面两者都有、每次都在跑。`tabcap trace start --decode`（`--no-decode` 关闭；config.json `trace.decode` 设默认）在页面上装三个 sink 断点，把页面交给 `JSON.parse` 的明文归属到加密响应，写进 `decoded.jsonl`（§28 的 sidecar 形状）成为 `by:"page"` 的 `decoded` 视图；`find` / `where` / `deps` / `recon` / `replay check` 经内置链步骤 `page` 读它。**对页面做什么（作者 10-16 定的表述，0.6-L2）：不改页面状态；在页面里只调用原生 `console.dirxml`（log-point，见下）；不拿页面函数处理 tabcap 的数据；`CryptoKey` 永不读。**守卫要读 `console.dirxml` 和它的 `name`，页面若在这两处装了 getter，getter 会执行（页面也就能察觉观察模式——它本来就能从时序察觉）；守卫能被同名函数骗过，后果是页面拿到它自己的明文、tabcap 这次退回作用域。`--decode` 时**不装签名断点**（作者 10-16 定）：不读 signals.json、不设 API 断点、instrumentation 只留 scriptFirstStatement 安装通道；`--apis` 与 `--decode` 同给报 `usage`。证据包规范之外它是诊断组命令，不进 MCP core、不进 SKILL.md 本体（文档在 `skills/tabcap/references/trace-and-probes.md`）。

sink 与断点（D1；spike exp2/exp3，e2e【实测】）：
- `JSON.parse`——明文源，condition `typeof arguments[0] === "string" && arguments[0].length >= 32`（exp2：2000 次短 parse 的 heavy 页带 condition 中位 +15 ms，不带 +837 ms）；
- `TextDecoder.prototype.decode`、`SubtleCrypto.prototype.decrypt`——只计 `evidenceHits`，不给行（D1）；TextDecoder 带 condition `byteLength >= 32`，decrypt 调用稀少不设。
- **修正（按实现定案，作者 2026-10-21 批量签收）：sink 常装**。brief D3「每 suspect 5 s 窗口装断点」与页面竞态必输：arm 由录制 index 推送驱动，而页面的 fetch→解密→`JSON.parse` 在同一微任务串里结束（s59 xor【实测】，首轮 e2e 三次全 miss）。改为 decode 开启即常装：每个 realm 在其 scriptFirstStatement 暂停里装好（0.4-F 的安装通道，JS 内建断点**不**跨 realm 共享，逐 realm 装；同进程重复报 "already exists"、容忍），armed 窗口只做归属。
- **修正（按实现定案，作者 2026-10-21 批量签收）：hold 10 s 补匹配**。微任务串还可以再赢一次：暂停时 armed 为空的 walk 结果先暂存（≤8 个、10 s 过期；0.6-W 起 ≤256，且有别的嫌疑在场、没有 scope-string 命中时也先暂存，见 0.6-W 节），arm 一到由 `matchHeld` 补判（归属规则不变）。信封 parse（`{"code":0,"data":…}` 那层）没有明文、其 suspect 也不会命中，自然过期——`drops.plaintextMissing` 里的这类计数是语义内的噪声（「该次暂停没找到明文」），不是错误。

suspect 与窗口（D3）：finished 响应、无 `decoded` 视图、body 过 `find` 的熵规则（`looksEncrypted`）或 JSON 里有 ≥64 字符的 base64/hex 叶子（0.6-L2 起还有裸 token，见下节）→ arm 5 s；候选 = sha256(整段 body 文本，熵规则命中时) + sha256(每个叶子)，0.6-L2 起末尾再加 sha256(原始 body 文本)（页面拿着原文解密时也能对上，如 axios 的 `transformResponse(data)`）。

归属（作者 10-16 定，替换 brief 的 sequence/recent；**绝不按时间取最近**）：
1. scope-string：暂停帧 local/closure/block 里某个字符串值——0.6-L2 起也包括这些 scope 里普通对象往下一层的字符串属性——的 sha256 命中某 live suspect 的候选 → 该 suspect，`evidence.link: "strong"`；
2. 恰有一个 live suspect → single-suspect，`evidence.link: "weak"`（0.6-L2，作者 10-16 定）：作用域里没有任何东西把明文和这个响应连起来，只是窗口里只有它；`find` 在这种视图里的 hit 带 `"link":"weak"`；
3. 否则 unattributed：行 `request: null`、`evidence.candidates` 列出当时全部 live suspects；每录制至多 50 行（D7），超出计 `unattributedCapped` 丢弃。

明文恢复（0.6-L2 主通道，见下节）：JSON.parse 的 condition 用 log-point 发出被调实参；作用域 walk（≤4 帧 local/closure/**block**，每 scope ≤200 属性；其中 className 为 `Object` 的普通对象往下读一层，每次暂停 ≤16 个、只取字符串做哈希——`ownProperties` 的 `getProperties` 不调用 accessor；数组不进（`getProperties` 会列出全部下标），DOM / Proxy / Map 等也不进）只做密文 sha 匹配，log-point 被页面换掉 `console.dirxml` 时才当明文回退。ArrayBuffer/TypedArray 经 objectId 只读 `callFunctionOn` 复制字节（CSV，> 16 MiB 不复制计 oversize；有 log-point 明文时不复制）；`CryptoKey` 从不触碰。明文 <32 字符不成候选，>16 MiB 只当 evidence（tooLarge）。守卫不过（`console.dirxml` 被换成匿名函数）就不调用、退回暂停。tabcap 自己的 evaluation 与隔离世界帧的暂停一律丢弃（0.4-F 实测：JS 内建断点跨 context 也会打进来）。

行形状（§28 的 sidecar 行 + `evidence`；oracle 是靶场 s59 的字面量，e2e `v06l`）：

```jsonc
{ "seq": 1, "request": "r-13", "direction": "response",
  "decoded": { "by": "page", "version": "observe/0", "mime": "application/json",
               "blob": "sha256:…", "bytes": 245, "ok": true,
               "evidence": { "sink": "JSON.parse", "match": "<命中的密文 sha256 或 null>",
                             "matchForm": "stripped",                                   // 只 strong 行：raw / stripped / unquoted / urldecoded（0.6-Q）
                             "link": "strong",                                          // 或 "weak"；unattributed 行没有（0.6-L2）
                             "frames": [ { "url", "line", "column", "function" } ],      // ≤5
                             "at": 1760000000000, "candidates": ["r-13"] } },              // 只 unattributed 行
  "at": 1760000000000 }
```

- 行的优先级（D4）：ok 的插件视图 > ok 的 page 视图（page 行后写也顶不掉插件行）；同 rank 后行赢；inline 视图按同一 rank 裁定；`request:null` 的行不 overlay 任何请求。
- **启用的解码插件提示（0.6-U，来自真实项目复测 10-17：插件匹配了流量，观察模式几乎不出 `by:"page"` 行，用户不知为何）**：`trace start --decode` 的回答在有已启用的解码插件（§28，`plugin enable` 过且清单有效）时多两个字段：`decodePlugins: [<插件名>…]`（按名字排序）与 `decodePluginsNotice`（一句话：插件已写过视图（解出或失败）的响应体不再观察，插件视图又优先于 page 视图（D4），所以插件匹配流量时 `by:"page"` 行很少；想看页面就 `tabcap plugin disable <name>`）。开始时还不知道会话的流量会不会被匹配，所以只看「有没有已启用的」，不看主机。没有已启用的解码插件时这两个字段都不出现；`alreadyOn` 的回答不带。【实测 单测 `test/unit/trace06u.test.ts`，假插件目录】
- 停与清场：`trace stop` / `net stop` 连 sink 断点一并移除，armed 清空计 `drops.afterStop`。
- **`decode` 块**（`trace start --decode`、`trace status`、`trace stop`；0.7-C 起默认是紧凑形，按实现定案，作者 2026-10-21 批量签收）：`{on, weakRows, rows:{strong, weak, unattributed}, pending, dropped}`。`--verbose`（`trace status` / `trace stop`）在同一块里再加背后的计数器。字段：

| 字段 | 形 | 含义 |
|---|---|---|
| `on` | 紧凑 | sink 断点在、trace 在跑：暂停正被观察。`false`：录制已停（sink 随 `net stop` 撤下，下一次 `net start` 再装）或 trace 已停 |
| `weakRows` | 紧凑 | `config.json` `trace.weakRows`：single-suspect 行写入（`true`）还是计 `drops.weak`（`false`），0.6-V |
| `rows.strong` | 紧凑 | scope-string 归属的行（= `rows.attributed` − `rows.weak`） |
| `rows.weak` | 紧凑 | single-suspect、`link:"weak"` 的行 |
| `rows.unattributed` | 紧凑 | `request:null` 的行 |
| `pending` | 紧凑 | 还没判定的 parse：`held` + `settling`。stop 之后恒为 0 |
| `dropped` | 紧凑 | 下面 `drops` 全部原因之和 |
| `decidedAtStop` | 只在 `trace stop` | stop 开始时还没判定、由 stop 强制判定的 parse 数（就是当时的 `pending`）；它们的结果已经算进 `rows` 或 `dropped` |
| `rows.attributed` | `--verbose` | strong + weak |
| `armed` | `--verbose` | 窗口内的嫌疑数 |
| `held` | `--verbose` | hold 里的暂停（0.6-W 的 grace，或等 arm）；stop 之后为 0 |
| `settling` | `--verbose` | 在 500 ms settle 里、还没写的 weak / unattributed 行；stop 之后为 0 |
| `unattributedKept` | `--verbose` | 本录制已写的 unattributed 行（上限 50，D7） |
| `evidenceHits` | `--verbose` | `TextDecoder.decode` / `SubtleCrypto.decrypt` 的暂停数（只作证据，D1） |
| `recovered:{console, scope}` | `--verbose` | 明文来自 log-point / 作用域 |
| `walks` | `--verbose` | 作用域 walk 次数 |
| `sinks:{resolved, skipped, on}` | `--verbose` | 装上的 sink 断点、没装上的、sink 意图开着（trace stop 后不改，所以 stop 的回答里仍可能是 `true`；看紧凑的 `on`） |
| `drops:{plaintextMissing, tooLarge, afterStop, unattributedCapped, rawBody, orphan, unpaired, noFit, weak}` | `--verbose` | 按原因：没找到明文、明文超 16 MiB、录制 / trace 已停、unattributed 超上限、明文就是某个录到的原文 body、没遇上任何在场嫌疑（`orphan`）、没配上暂停的 log-point 行（`unpaired`）、明文超过所有在场嫌疑的上限（`noFit`，0.6-Q）、`trace.weakRows:false` 时本会写入的 weak 行（`weak`） |

  **`trace stop` 先判完再回答**：stop 先等正在跑的那一轮补判，再把还挂着的 parse 全部判掉，再 flush settle，然后才读这个块（0.6-W 起）。所以 stop 的回答里 `pending` 是 0，那些 parse 的结果已经在 `rows` 或 `dropped` 里——没遇上任何响应（在场嫌疑）的计入 `dropped`（`drops.orphan`），不是「还挂着、丢了」。0.7-C 前回答里的 `held` 在 stop 时表示「stop 开始时挂着的数」，读者会把它和 `orphan` 当成两拨丢失，现在由 `decidedAtStop` 说这件事。【实测 e2e `v06l` s59 noise：stop 回答 `pending` 0、`dropped` ≥1（含 1 个 orphan）】

字面自定（NOTES 待审）：`sinks.skipped` 只计 evaluate 拿不到函数对象或 setBreakpoint 没返回 bpId；「already exists」的 catch 不计数（它是良性共享信令）；plainText 长 ≥32 / scope 字符串 ≥16 / hold 10 s / hold ≤8（0.6-W 起 ≤256）/ grace 1.5 s（0.6-W）/ evidence frames ≤5 / mime 固定 `application/json`（明文必须过 `JSON.parse`）；`--text / --first-n` 等 trace 原有旗标与 decode 无交互。

### 0.6-L2（10-16）：实参走 log-point；上限 16 MiB；裸 token 嫌疑

【实测 spike-06l2，CfT 155，真实守护进程】0.6-L 只从暂停作用域捞明文，真实页面里 `JSON.parse` 的实参经常是临时值：axios 式 `transformResponse(data)` 把信封写成了 `by:"page"` 视图（错证）；`JSON.parse(decrypt(res.data))` 内联 0 行；s59 worker（`JSON.parse(e.data)`）0 行；整段 body 是一条低熵 base64、没有 JSON 信封时不进嫌疑。根因是函数调用断点读不到被调实参（§33 上段 exp4），作用域里也没有那份临时明文。

改动（作者 10-16 定 log-point 通道；同日第二轮作者定：强关联加两条 + weak 标记、对页面做什么的表述、`--decode` 不装签名断点；其余按实现定案，待审）：

- **明文主通道是 log-point**。`JSON.parse` 的 condition 在长度门之后、且 `console.dirxml` 仍是原生函数时（`console.dirxml.name === "dirxml"`；页面换成匿名函数则守卫失败、退回暂停+作用域，**不调用页面函数**——spike E7），执行 `console.dirxml(nonce, arguments[0])`。`nonce` 是本窗口随机标记；录制器的 console 捕获丢掉带它的消息，明文不进 `console list`。`Runtime.consoleAPICalled` 严格先于同一次 parse 的暂停（spike E6），按 session 排队、**按位置配对**：取第一条「栈前三帧里有暂停顶帧位置（scriptId:line:column）」的行（spike E10：log 的调用方帧就是暂停顶帧），排在它前面的行丢了暂停、计 `drops.unpaired`，超过 10 s 的行作废；没有栈帧的行按顺序配；交接期间（skip pauses）来的行不入队。condition 仍为真，暂停照旧走，作用域只做密文归属（scope-string）和守卫失败时的明文回退。
- **明文上限 16 MiB**（原 1 MiB）。超过只记 `drops.tooLarge`、不给视图；仍低于 §5.2.4 的 32 MiB blob 上限。log-point 对超限实参发 `null`。
- **裸 token 嫌疑**（item 6）：整段 body 去空白后是一条 ≥64 字符的 base64 / hex（`[A-Za-z0-9+/=_-]+` 或 hex），即使熵到不了 `looksEncrypted`，也按去空白后的 sha256 武装。自定义字母表只要仍落在这套字符里就能武装；含空格或其它字符的字典仍不会，明文若出现则进 unattributed 或 `drops.orphan`。
- **原文排除**：每个已录响应体文本的 sha256 进 `rawShas`（含信封、`/api/plain` 对照）。log-point 拿到的明文若等于其中之一，计 `drops.rawBody`、不写行——这是信封不再被当成明文的规则。
- **single-suspect 先 settle 500 ms**：只有一个 live suspect、没有 scope-string 命中时（axios 的密文在对象属性里、worker 的 `e.data` 已是明文），先暂存再写。期间若该请求已被 scope-string 行占用、或明文后来对上了 `rawShas`（对照接口自己的 body 刚写入），则丢。scope-string 行立刻写。每请求至多一行（`filedRequests`）。
- **orphan**：hold 10 s 内没遇上任何 suspect 的暂停只计数（`drops.orphan`），不写 `request:null` 行。`find` 契约不变。
- **交接**：`setSkipAllPauses` 期间丢掉 log-point 队列，避免和后来的暂停错配。
- **实现修正（10-16 第二轮，【实测】诊断循环：同一守护进程连跑 s59 各变体，修前 8 次里 2 次零行、axios 每次约 5.4 s 才出行；修后 18/18 出行，axios ≈0.45 s，weak 的 deferred ≈0.85 s；e2e v06l 连跑 3 次 9/9）**：
  - 暂停的「有无 live suspect」改在 walk 的 await **之后**读（L2 初稿把它挪到了 walk 之前：walk 期间到达的 arm 已经跑过补判，这次暂停再按「无嫌疑」暂存就没人再判，10 s 后成 orphan——零行的根因【推断，修后不再复现】）；`matchHeld` 串行执行、每个暂停先摘下再判、每次重读 armed 列表。
  - sweep 定时器遇到更早的截止时间就重排：settle 500 ms 不再等 5 s 的嫌疑窗口定时器。
  - `rawShas` 满 8192 后淘汰最旧的，不再停止收录（长录制里信封又被当成明文的回归）。
  - sink 打开时给已追踪的 target 补装：先 `trace start --decode`、后 `net start` 时，已加载页面以前要等下一次导航才有 sink（0.6-L 起就有的缺口；e2e 新增一条，去掉补装即零行【实测】）。

残留风险（不在本格处理，记下）：scope-string 只说明「解析帧够得着这段密文」，不说明实参就是它解出来的——同一函数里先 parse 一段无关 JSON（配置、`__NEXT_DATA__`）再解密，无关那次会先以 strong 写入，每请求一行，真明文被挡掉；weak 的同类情况在 settle 里先到先得。要更好得等页面侧的因果证据（0.7 call mode）。

本格**不做**（留给 0.7 或后续）：请求侧加密（只观察响应；生成客户端仍靠解码插件或人写）；分块 / 流式解密（SSE、分页拼接，没有一次完整 `JSON.parse`）；Worker `postMessage` 对象（结构化克隆，主线程不再 parse）、WASM 自带 JSON、明文是 HTML / protobuf / JSON5——没有 `JSON.parse` 就看不见。靶场 s59 `mode=worker` 是「worker 回字符串、主线程再 parse」，已有 e2e；对象克隆仍【待验】。

开销（spike-06l2，页面侧 500 次 1 KB parse）：不设断点 0.2 ms；只有 length condition 9 ms；log-point 26 ms；暂停后立即恢复（不含 walk）107 ms。诊断可接受，**录完就关**（`trace stop` / `--no-decode`）。

### 0.6-Q（10-17）：嫌疑哈希的四种形式、明文长度上限、信封竞态、net body 读 page 视图

依据（隔壁项目真实站点 A，10-17，匿名化；ground truth 是解码插件对 91 条加密网关响应给出的明文）：P0 召回 11%——91 条里 76 条的 base64 是 MIME 式（每 76 字符一个换行），页面解密前先去空白，作用域里的字符串和原文、叶子都对不上哈希，一条 strong 也没有；10 条 strong 全是不带换行的 64 字节短 body，与插件明文 10/10 一致。（换行，strong）交叉表：（无，有）10、（有，无）76、（无，无）5。P1：一条 64 字节密文（明文 ≤48 字节）下挂了 895 字节的 weak 明文，那是页面从 localStorage 解析用户信息；一条 unattributed 行与某个原始响应体逐字节相同（1450 字节，axios `transformResponse` 解析的信封；测试方【推断】页面在 tabcap 索引该响应之前就 parse 了，原文排除没赶上）；`net body <id>` 不读 page 视图；`--decode` 藏在诊断组的 `trace start` 下，从录制流程找不到。

改动（作者 10-17 的 brief A–F；下列字面按实现定案，作者 2026-10-21 批量签收）：

- **四种形式（A）**。每个密文候选（熵规则命中的整段 body、JSON 叶子、裸 token）按页面可能拿着的形式各算一份 sha256，至多 4 份：`stripped`（去掉 `\r` `\n` `\t` 空格，与原文不同时）、`unquoted`（去掉一对首尾双引号）、`urldecoded`（`decodeURIComponent` 改变了它时；含孤立 `%` 解不开就不算）、`raw`。顺序是变换过的在前、`raw` 在后：两种形式同时在作用域里时（mime 页面的 `s59Xor(data)` 里有去空白后的 `data`，外层 `env` 往下一层是带换行的原文），`evidence.match` 取变换过的那份——它只因为页面自己做了规整才存在，离解密调用更近。原始 body 文本的 sha（0.6-L2）仍排在所有候选之后，形式记 `raw`。叶子和裸 token 的判定也先规整（去空白、去一对引号、URL 解码）再看是不是 ≥64 字符的 base64 / hex：MIME 式叶子、带引号或 URL 编码的裸 body 以前根本不进嫌疑。裸 token 的候选仍是 trim 后的 body 文本（页面 `atob(body.trim())` 照旧以 `raw` 对上）。strong 行加 `evidence.matchForm: "raw" | "stripped" | "unquoted" | "urldecoded"`，`match` 仍是命中的那个 sha；weak / unattributed 行没有这个字段。
- **明文长度上限（B）**。每个候选给出它最多能解出的明文字节数：base64 → floor(去空白后长度 × 3 / 4)，hex（全是十六进制且长度为偶数）→ 长度 / 2，熵规则命中的整段 body → 它的字节长度；一个嫌疑的上限取其候选中最大的。**假设：加密前没有压缩**（gzip 后再加密的站点，明文可以比密文长，见下一条的豁免）。明文的 UTF-8 字节数超过某嫌疑的上限，就不可能出自它：该嫌疑退出 single-suspect（weak）和 unattributed 的候选；剩下恰好一个能装下的嫌疑就是 weak，多于一个就是 unattributed、`candidates` 只列能装下的；一个都没有就丢掉这次暂停，计 `drops.noFit`。**scope-string（strong）不受上限约束**：作用域里有密文本身，压缩的站点也照常出 strong 行。hold 中的暂停在 arm 到来时按同一规则判，判成 noFit 也就地丢弃（不再等下一个 arm）。
- **信封竞态（C）**。unattributed 行和 weak 行一样先 settle 500 ms 再写；flush 时再对一遍原文 sha（`rawShas`），也再查一遍 50 行上限（超出计 `unattributedCapped`）。每当一个原始 body 被索引，settle 队列和 hold 里明文 sha 等于它的条目立即丢弃，计 `drops.rawBody`。50 行上限不变。
- **`net body` 读 page 视图（D）**。默认和 `--decoded` 都按 D4 的 rank（ok 插件视图 > ok page 视图，同 rank 后行赢）解析视图：索引里的内联视图（录制时的插件）叠上 `decoded.jsonl` sidecar（`bundle decode` 的行和观察模式的 page 行），经 `src/analyze/views.ts` 的 `decodedPayload` 读（blob 缺失或超过 32 MiB 的不算视图），与 `analyze find` 同一条路；录制中与录制后一样。page 视图的回答里 `decoded` 多一个 `link`。没有视图时 `--decoded` 仍报 `not-found`；body 是观察模式会武装的那种（与 `suspectOf` 同一规则：`find` 的熵规则、≥64 字符的 base64 / hex 叶子或裸 token）时，`next` 先指 `tabcap trace start --decode`，再说插件。偏离 brief 一处（按实现定案，作者 2026-10-21 批量签收）：brief 写的是「过 `looksEncrypted`」，但带 base64 `data` 的 JSON 信封本身熵只有约 6 bit/字节，永远过不了 `looksEncrypted`——真实站点那 91 条正是这种，所以提示用观察模式自己的嫌疑规则（它包含 `looksEncrypted`）。
- **可发现性（E）**。`net start` 的 summary 加一句「encrypted API responses: add `trace start --decode` …」（在分号之后，help 索引只取第一个子句，索引大小不变：6490 B，上限 8 KB【实测】）；`references/recording.md` 加一句。`net body` 的 summary 与 `--decoded` 的说明改为「decoded view（插件，或 `trace start --decode` 的 page 视图）」。
- `trace status` / `trace stop` 的 `decode.drops` 多 `noFit`。

靶场（docs/05 s59 `mode=mime` / `noise` / `race`，e2e `v06l`）：mime → 一条 strong、`matchForm:"stripped"`、`match` = sha256(去空白后的 `data`)，`net body` 默认与 `--decoded` 在录制中和 `net stop` 后都是 page 视图；noise → localStorage 那次 parse 不落行、`drops.noFit ≥ 1`、两条真明文照样 strong；race → 没有任何一行等于某个信封、`rows.unattributed` = 0。

残留（不在本格处理）：上限假设加密前不压缩，压缩站点的真明文若只能 weak / unattributed 归属，会被当成 noFit 丢掉（strong 不受影响）；上限按 UTF-8 字节数比，页面若把 latin1 风格的字节串（`String.fromCharCode` 逐字节、未再做 UTF-8 解码）交给 `JSON.parse` 且含非 ASCII，UTF-8 长度会大于字节数而被误排除——按 UTF-16 码元数比较可以避开（码元数在两种解码方式下都不超过字节数），作者定；noFit 在 hold 里也是就地丢，若真明文的 parse 赢了自己的 arm、而当时在场的只有装不下它的别的嫌疑，这条会丢（改为继续 hold 到 10 s 再计 noFit 可以救回，作者定）。

### 0.6-V（10-17）：weak 行可关、证据帧带脚本 URL、status 也带插件提示

依据：隔壁项目两轮真实站点测试（站点匿名）：weak 行（`evidence.link:"weak"`）在每个真实样本上都归错了；外部脚本的 `evidence.frames[].url` 全是 `""`。作者 10-17 定：

- **`trace.weakRows`**（`config.json`，布尔，**默认 `true`**：作者 10-17 上午先定默认关，随后改为默认开、可关）。`true` 是原行为：single-suspect 行 settle 500 ms 后以 `link:"weak"` 写入，计 `rows.weak`。`false`：single-suspect 行照样 settle，到 flush 时本来会写入的（不是原文 body、该请求还没有行）改为不写，计 `decode.drops.weak`（`trace status` / `trace stop` 的 `decode` 块）；因原文 body、已有 strong 行而丢的照旧计在原处，所以 `drops.weak` 只数「本会写入的 weak 行」。`trace start --decode` 的回答带 `weakRows: true|false`，`decodeNotice` 按它说明 weak 行的去向；`trace status` 在观察模式下也带 `weakRows`（0.7-C 起在 `decode` 块里：`decode.weakRows`，顶层不再有）。非布尔值报 `bad-input`。
- **证据帧的 URL**。根因【实测 10-17，e2e v06l 对照】：CDP `Debugger.CallFrame` 的脚本 id 在 `location.scriptId`，调用帧顶层没有 `scriptId`；0.6-L 的 `framesOf` 读顶层 `scriptId`，永远是空，于是查不到 `Debugger.scriptParsed` 表，每个 URL 都是 `""`——与脚本是否在 tracer 挂上之前解析无关。对照实验：只用 scriptParsed 表（按 `location.scriptId`）时 s59 的 xor / axios / 「trace start 之前已载入的页面」三条都拿到页面 URL（后者的内联脚本在 tracer 挂上之前就解析了：`Debugger.enable` 会为已有脚本补发 `scriptParsed`）；换回读顶层 `scriptId` 时同一断言得到 `""`。现在 `evidenceFrames` 先用帧自己的 `url`（CDP 标为 deprecated 但仍在发），再用表，都没有才是 `""`。同一个错也让观察模式的「tabcap 自己的脚本 / 隔离世界」过滤从未生效（`onSinkPause` 同样读顶层 `scriptId`），一并改为 `location.scriptId`（`frameScriptId`）【推断：之后 tabcap 自己 `evaluate` 里的 JSON.parse 不再进观察路径；靶场没有专门断言】。
- **`trace status` / `trace stop` 带插件提示**：观察模式开着时，与 `trace start --decode` 一样带 `decodePlugins` / `decodePluginsNotice`（有已启用的解码插件时；`withDecodePlugins`）。

靶场（e2e `v06l`）：s59 xor / axios / inline / worker / 「之前已载入」的行，顶层帧 `url` 是页面 URL（这些 parse 都在页面内联脚本里；worker 模式下 worker 只把明文字符串 post 回来，由主线程 `onmessage` 里的 `JSON.parse` 解析——看 `test/e2e/site.ts` 的 `s59Worker`——所以顶层帧不是 worker 脚本）；deferred 默认配置照旧写一条 weak 行（`rows.weak 1`、`drops.weak 0`），`config.json` `{"trace":{"weakRows":false}}` 时不写行、`drops.weak` = 1、`find` 无命中。【实测 10-17，本机 CfT：`v06l` 14/14 连续两次】

### 0.6-W（10-17）：无作用域命中先等 grace、arm 到即重配（作者定 A；B 进 0.7）

依据【隔壁实测，10-17，站点匿名】：观察模式在真实站点上仍有行丢失或归错，隔壁项目找到原因：

- 嫌疑在录制器写完响应（索引推送）之后才武装（`onEntryIndexed`）；用 XHR 的页面在 `onload` 里就 parse 了，早于索引。暂停时**没有**在场嫌疑 → 暂存、arm 到时补判（`matchHeld`），这条 0.6-L 起就对；但**有别的**嫌疑在场时（页面取回却从不 parse 的响应、并发请求），`onSinkPause` 当场判：single-suspect（错的 weak 行）、unattributed（真请求不在候选里）或 no-fit。
- 当场判不 `forget` 任何嫌疑，没人认领的嫌疑整整 5 s 窗口都在场，把之后的暂停都拖进同一条错路（其 debug 日志里在场嫌疑从 3 涨到 42）。
- 本地复刻页（XHR，加 3 个页面取回却从不 parse 的加密响应）在 05:03 的构建上 0/40 strong；改用 `fetch()` 是 39/40（`text()` 要等流读完，通常晚于 arm）。其 74 行原型（即下面的 A）：复刻页 40/40 连续三次；真实站点对照解码插件明文 51/51；单测 1155/1155；v06l 12/13。

改动（作者 10-17 定 A，「按 A 修」；下列字面按实现定案，作者 2026-10-21 批量签收）：

- **当场只判 scope-string**：strong 行照旧立即写。其他结果（single-suspect / unattributed / no-fit / 没有在场嫌疑）一律进 hold（明文、作用域 sha、证据帧、`at` = 暂停时刻），sweep 排在 `GRACE_MS + 50` ms。例外：没读到明文（log-point 守卫失败、作用域里也没有）而有嫌疑在场的暂停当场判——它归哪个嫌疑都只会计 `plaintextMissing` / `tooLarge`，等也不变。
- **重配（`matchHeld`，每次 arm、每次 sweep）**：hold 里的暂停从旧到新、各自按那一刻的在场嫌疑重判（每个先摘下再判；前一个写入时 forget 的嫌疑后一个就看不到）：scope-string 立即判（strong）；其他结果等到 `at + GRACE_MS`（1.5 s）之后，按那一刻的在场嫌疑判 weak / unattributed / no-fit（规则同 0.6-Q，weak 受 `trace.weakRows` 管）；那一刻没有在场嫌疑就继续 hold、等下一个 arm，`HOLD_MS`（10 s）到期计 `drops.orphan`。纯函数 `heldVerdict` / `heldWaits` / `passHeld` 在 `observe.ts`，单测 `test/unit/observe06l.test.ts`。
- **强制判定**：`trace stop` 与录制停止（`net stop`）先等正在跑的那一轮 `matchHeld`，再把 hold 里全部暂停判掉（force），然后才是强制 settle flush——判成 weak / unattributed 的行先进 settle 队列，由同一次 flush 写出。force 时没有在场嫌疑的暂停计 `drops.orphan`。
- **两个计数器的分工**：`orphan` = 到判定时（10 s 到期或 stop 强制）一个在场嫌疑都没遇上的暂停；`noFit` = 判定时有嫌疑在场、但明文超过它们全部的上限。s59 noise 的 localStorage 那次 parse 在 0.6-Q 是当场判 noFit；现在它先 hold，grace 内两条噪声明文都以 strong 写入（各自的嫌疑被 forget），grace 到时没有在场嫌疑，由 `trace stop` 强制判成 orphan——noise 的断言改为 `drops.orphan ≥ 1`、`drops.noFit` = 0。
- `HOLD_MAX` 8 → 256（每条只有几个 sha、明文与 ≤5 帧）；满了丢最旧的（不计数，旧行为）。
- **`decode.held`**（`trace status` / `trace stop`；0.7-C 起只在 `--verbose`，紧凑形里并进 `pending`）：还挂着的暂停数；0.7-C 前 `trace stop` 里是 stop 开始时挂着、由 stop 强制判定的数，现在这个数叫 `decidedAtStop`，`held` 在 stop 之后为 0。`trace stop` 的 `decode` 块改为停止**之后**读：强制判定出的行、drop 与 flush 的 settle 行都算进去（0.6-V NOTES 待审 (c) 的缺口一并补上）。
- **行可能晚到**：非 strong 的行比 parse 晚至多约 1.5 s（加 settle 的 sweep）才出现；轮询 `decoded.jsonl` / `find` 的脚本要多等。
- **没人认领的嫌疑**：判成 unattributed / no-fit 的暂停不 forget 与它混淆的嫌疑，它们照旧活到自己的 5 s 窗口结束（不变）；嫌疑自己的明文一旦写入（strong 或 weak）就 forget（`fileDecidedRow`，0.6-L 起）。grace 之后，这些在场的嫌疑不再能当场把别人的暂停拉走，所以本格不缩短它们的窗口。

靶场（docs/05 s59 `mode=xhr`、`mode=xhr&linger=3`，e2e `v06l`）【实测 10-17，本机 CfT】：修前（main 2ac7ea9 加本格的靶场与 e2e）`mode=xhr` 单独通过（没有在场嫌疑 → hold → arm 补判，0.6-L 起就对），`mode=xhr&linger=3` 第一轮即失败：唯一一行 `request:null`、`candidates` 正是三个 linger 请求，没有 strong 行；修后两者都是恰好一条 strong 行（`match` = sha256(`data`)），linger 一个用例里连跑三轮 3/3，整份 `v06l` 16/16 连续三次，`v06b` 5/5。

**B 进 0.7（作者定）**：在 `Fetch.requestPaused` 的 Response 阶段按 `networkId` 武装（页面拿到 body 之前），从根上消掉这个竞态。代价【推断】：要开 Fetch 拦截、对每个响应放行，会改页面时序——属于 AGENTS.md 里「会改页面行为的插桩」，要默认关或显式模式。grace 是在那之前的近似：parse 与 arm 隔了超过 1.5 s，或 grace 结束时恰好只有一个装得下的别的嫌疑在场，仍会错配（weak 行，受 `trace.weakRows` 管）。

## 34. 0.6-P `fetch --credentials` 与 `session export --origin`（10-17 主循环定需求；字段与下列细节按实现定案，作者 2026-10-21 批量签收）

【实测】作者邻近项目 10-17 用 0.6.0 跑真实站点（站点匿名）：页面在一个源、API 在另一个源。网关回 `Access-Control-Allow-Origin: *`，`tabcap fetch` 写死 `credentials:"include"`，Chrome 拒读（"must not be the wildcard '*' when the request's credentials mode is 'include'"）、报 `fetch.blocked`；另一个后端发重复的 `Access-Control-Allow-Credentials: true, true`，同样被拒（"is 'true, true' which must be 'true'"）。页面自己的代码用 `withCredentials: false`，能通。旧提示「先导航到同源页面」让 Origin / Referer 变成 API 源，后端回 403；只有 `omit` 可行。同一个单页应用的 `session export` 给出 `headers: []`：它只看发往页面源的请求，认证头却发往 API 源。

- **`--credentials include|same-origin|omit`**（默认 `include`，即原行为）：就是页面 `fetch()` 的 `credentials` 选项（Fetch 规范 RequestCredentials）。`--batch` 每行可带 `credentials`；命令行的 `--credentials` 是没写的行的默认值（与 `--timeout` 同）。`POST /fetch` 收 `credentials` 字段；`_tabcap_fetch.py` 的 `fetch(..., credentials=None)`（`None` = 守护进程默认）。值不在这三个里 → `usage`。
- **记在包里**：这次 fetch 的每个 `request` 事件（含重定向跳、预检）带 `fetchCredentials`（§5.1）；`cmd` 开始事件的 `input.credentials` 总是写出所用模式（没给就是 `"include"`），`--batch` 写成 `input.batch:{requests:n, credentials:{<模式>:<行数>}}`。成功信封不加字段；`fetch.blocked` 的错误带 `credentials`。
- **`fetch.blocked` 的 `next`**：模式是 `include`、且 Chrome 的理由以 "when the request's credentials mode is 'include'" 收尾并点名 `Access-Control-Allow-Origin` 的通配 `*` 或 `Access-Control-Allow-Credentials`（缺失、重复如 `true, true`）时，`next` 先给「改用 `--credentials omit`（`POST /fetch`：`"credentials": "omit"`）；那样不带 cookie，API 用头认证（如 `Authorization`）时没问题」，再给「或先把标签导航到目标源的页面再发，那样请求的 Origin / Referer 变成目标源，有的后端会拒」。其余 CORS 理由（如没有 ACAO）只给导航那条。【实测：s60 两种理由的 Chrome 原文，CfT 155】ACAC 缺失那一种的原文没有靶场对照【推断：同一模板】。
- **不做 `--referrer`**：页面 `fetch()` 的 `referrer` 只能是同源 URL（或 `about:client` / 空串），跨源值被浏览器忽略换成 `about:client`（Fetch 规范 Request 构造步骤）【推断：读规范，未实测】；想要别的 Referer 只能导航到那个源，这就回到上面的第二条。理由写进 NOTES（按实现定案，作者 2026-10-21 批量签收）。
- **`session export --origin <url 或 host>`**（§8.2）：头取自录制里发往该源的最近一条带选中头的请求（不论哪个标签），cookie 加上该源的（`Network.getCookies` 带它的根 URL），与页面的并列；标签上没有该源的 frame 时 storage 读页面的。裸 host 的 scheme 取录制里的，没有用 `https`。
- **不给 `--origin` 的回退**：照旧选页面源；选出的头里没有敏感头时，改取录到的「最近一条带敏感头的请求里敏感头最多」的 host（并列取更晚），`source.headers:{request, origin, auto:true}`，`note` 说明并建议 `--origin`；那个源的 cookie 也一并取（`--origin` 同理）【按实现定案，作者 2026-10-21 批量签收：需求只说回退头】。值永不打印（原规则）。
- 验证：`test/unit/fetch06a.test.ts`（规格、CLI、helper、`cmd` 输入、提示规则、假浏览器上逐请求的 `fetchCredentials`）、`test/unit/session-export.test.ts`、`test/e2e/v06p.e2e.test.ts`（`05` s60）。

## 35. 0.7-B `tabcap status` 与 conflicts（10-17 作者定需求；字段与规则文字按实现定案，作者 2026-10-21 批量签收）

【实测】作者邻近项目 10-17 用 tabcap 跑真实站点的 agent，大半时间花在隐含状态上：会话卡在 `waiting`，`guard resume` 解不开；启用着的解码插件让观察模式的 page 视图排不上；`net start` 隐式造出的会话没绑站点，`fill --secret` 失败；忘了还开着的录制和 trace 窗口。这些状态原先散在 `daemon status`、`session list`、`trace status`、`plugin list`、`handoff status` 和 guard 输出里。作者接受 tabcap 用文字解释自己的状态（`conflicts`）。

- **一条命令一个信封**：`tabcap status [--text]`（守护进程动作 `status`）。只读、全局：守护进程在命令路径之前回答它（与 `daemon status` 同），所以不在任何录制里开 `cmd` 窗口、会话在 `waiting` 时也不被拒、回答不带 `trace` / `handoff` 附加字段。数据全部读守护进程已有的对象（标签表、录制器、tracer、guard、插件目录），本身不存状态。守护进程没在跑时 CLI 仍回 `ok`：`daemon.running:false`、空会话、插件照读配置目录。
- **回答**（`schema:"tabcap-status/0"`）：
  - `daemon`：`{running, pid, version, listener, socket, port?, startedAt}`（没在跑：`{running:false, listener}`）；
  - `browser`：`{running, pid, mode:"direct"|"ext"|null, tabs, webdriver, extraArgs, dropArgs}`（`tabs` 是未关闭的标签数；`webdriver` 见 §40，`extraArgs` / `dropArgs` 见 §42，浏览器没在跑时这三项为 `null`）；
  - `sessions[]`：每个会话 `{session, site, account, tabSite, tabs, current, url, recording, state, reason, screenshot, trace, guardStops, protection}`。会话取浏览器的会话表，再并上有录制、有 trace、有站点绑定、在 `waiting`、或停过 fetch 的名字（浏览器没了也列得出来）。`account` 只给用户名；`tabSite` 只给未绑定的会话：当前标签 URL 落在哪个库内站点（`fetch` 同一套 `siteOf`），否则 `null`；`url`（0.7-E）是当前标签（没有就是会话第一个标签）的 URL，没有标签为 `null`；`recording` 是 `{bundle, since, entries, decodePlugins}` 或 `null`（`entries` = 已写的请求条数，`decodePlugins` = 这份录制到目前为止用过的解码插件，0.7-E 前是 `net start` 时定下的）；`state` 是 `running` | `waiting`，`waiting` 时 `reason`（`verify-page` / `stop-rule` / `human-takeover`，§37）与 `screenshot` 有值（截图还在拍时 `status` 等它，最多 5 s，§36）；`trace` 是 `{state:"off"|"on"|"paused", decode, weakRows}`（`weakRows` 只在观察模式下是数，= 已归档的 `link:"weak"` 行）；`guardStops[]` 是落在本会话的 fetch 停手 `{site, rule, since, reason:"fetch-stop"|"stop-rule", by, request}`——由本会话触发、或站点等于本会话绑定的站点 / 当前标签所在站点 / 交接记下的站点；`protection`（0.8-A，§41.3）是当前标签页面上识别到的家族名（置信度 ≥ 50），只读按导航缓存的结果、不另探测，没有时为 `[]`；
  - `plugins`：已启用的 `{decode:[名字], challenge:[名字]}`；
  - `handoff[]`：在等人的会话 `{session, reason, site, url, since, screenshot}`（`url` 是 guard 交接时的那条请求，0.7-E）；
  - `conflicts[]`：`{code, session, message, next}`，规则按下列顺序生成（`src/daemon/tools/status.ts`，纯函数，输入是上面的事实）；
  - `next`（0.7-E，按实现定案，作者 2026-10-21 批量签收）：先做什么。有会话在 `waiting` 时每个这样的会话一句「告诉用户（附截图路径），人在浏览器里做完后 `tabcap handoff continue --session <s>`」，`; ` 连接；否则第一条冲突的 `next`；都没有为 `null`。
- **规则**（`next` 一律写成可直接执行的命令，带 `--session`）：
  - (a) `waiting-and-fetch-stop`：会话在 `waiting`，且有 fetch 停手落在它身上；`guard resume --site` 只解停手、不结束等待（例外：等待与停手出自本会话同一条站点停手规则时 `guard resume` 两个都解，此时不报）。`next`：人在浏览器里做完后 `tabcap handoff continue --session <s>`；停手由别的会话触发时再加 `tabcap guard resume --site <site>`（`handoff continue` 只解本会话触发的）。
  - (b) `decode-plugin-outranks-page`：会话在观察模式（`trace start --decode`）且有已启用的解码插件（0.7-E 起录制每个正文都重读插件表，所以有没有录制都看已启用的）；插件视图优先于 page 视图、插件解过的正文不再观察（§33 D4）。`next`：`tabcap plugin disable <name>`（一个插件写名字，多个写 `<name>`）；有录制时注明「从下一个正文起生效，已解过的正文保留插件视图」。0.7-E 前有录制时还要 `net stop` 与 `net start`（录制沿用开始时的插件），已作废。
  - (c) `unbound-session`：会话有标签、没绑站点，且当前标签落在库内站点（`tabSite` 非空）；`fill --secret` 会被拒（0.6-R 的 `unboundSecretError`，`src/daemon/tools/input.ts`）。只浏览库外页面的会话（如普通的 `default`）不报（作者 10-17 定，收窄了最初「有标签没绑站点就报」的写法）。`next`：需要库内密钥时 `session stop`，再 `session start <s> --site <tabSite>`。
  - (d) `recording-without-browser`：会话还开着录制，但浏览器没在跑或会话没有打开的标签；什么都进不了包。`next`：`net stop` 收包；浏览器还在时也可 `navigate` 继续录。
  - (e) `trace-without-recording`：trace 开着、会话没录制；signal / observe 行进不了任何包，直到 `net start`。`next`：`net start`，再重新加载页面。
- **`--text`**：一屏。首行守护进程、浏览器、已启用插件；每个会话一行（站点与账号、标签数与当前标签、录制条数与包路径、`WAITING <reason> at <url>` 与截图、trace、停手的站点与规则）；然后 `conflicts (n):`，每条一行 `- [code] message`、下一行 `  next: …`；没有冲突写 `conflicts: none`；最后一行 `next: …`（顶层 `next` 非空时）。
- **MCP**：`tabcap_status` 进核心集，替下 `handoff status`（`status` 已列出等人的会话与原因；`handoff status` 仍可经 `tabcap_run`）；核心集仍 24 个工具，定义 9047 B【实测：`test/unit/mcp.test.ts` 打印】。
- 验证：`test/unit/status07b.test.ts`（五条规则的正反例与顺序、(c) 不对普通浏览会话报、`--text`、无浏览器守护进程上的回答、无守护进程的回退）、`test/e2e/v07b.e2e.test.ts`（靶场 s07 / s15 与 `xor-decode`：绑定录制会话 + 标签在库内站点的未绑会话出 (c)，`data:` 页上的未绑会话不出；第 6 次 `fetch /api/limited --stop-on status>=400` 同时停 fetch 并进 `waiting` 出 (a)，`guard resume` 后 `handoff status` 仍是 `waiting`；`trace start --decode` 出 (b) 与 (e)，`net start` 后 (e) 消失、(b) 的 `next` 加上换录制）。

## 36. 0.7-E 上手验收后的发布前修正（10-17 主循环定范围；细节按实现定案，作者 2026-10-21 批量签收）

来源【实测】：邻近项目的 agent 只看 SKILL.md 与 `tabcap guide`，在一个真实站点和本地复刻上跑五个配方，结论「可以发布」，另有两处卡新人、几处小问题（站点匿名）。

- **B1 录制中启用的解码插件**：改为立即生效（§28「录制中启用 / 停用」）。`encrypted-site` 配方改成 `plugin init` → `plugin enable` → `net start` → 打开页面 → `net body`，提醒里写明启用之前录下的正文没有视图（`reload` 重录，或录完 `bundle decode`）。【实测 v06b：录制中 enable，`reload` 后新请求有视图、旧请求没有，`status` 的 `recording.decodePlugins` 从 `[]` 变成 `["xor-decode"]`】
- **B2 `offline-replay` 的 verify 在真实站点上过不去**：
  - (a) `replay export-python --request r-N`（§15 链的默认目标那条）；配方写上它，默认目标（开始最晚的有数据请求）常是统计 / 埋点调用。
  - (b) `verify()` 从上一步的答复里取链上能解析到来源的输入，名字敏感的也一样（`x-csrf-token`、`Authorization`），只对取不到的才要 `TABCAP_SECRET_*`。`verify_expected.json` 每步的 `derived[参数] = {from, as, path?, text?:{before, after}, plugin?:{name, dir, command, timeoutMs}}`：先（值来自解码插件视图时）把答复交给本机装着的那个插件（tabcap-decode/1，一行进一行出，环境与 tabcap 给插件的相同），再按 JSON 路径取（` -> ` 进入字符串里的 JSON，`json-unescape` / `json-string` / `json` 这几步可复现），否则按录到的值前后文本取（值在录到的答复文本里只出现一次时，前取 ≥ 12 字符、唯一的上文，后取不出现在值里的最短下文；HTML 里的 `<meta content="…">` 这类）。取不到的（`page` 观察模式视图、插件没装、值在文本里不唯一）进 `underived[参数] = 原因`，敏感的仍读 `TABCAP_SECRET_*`，失败信息带上原因。生成的 README 同步改写。【推断：验收里的 CSRF 值来自解码插件视图（同一包 `bundle decode` 解出 30/30），旧代码只接受无解码步骤的 JSON 路径，于是落到了环境变量；单测在 s42 合成包上复现了这条：不装插件时 `underived` 说明原因、args 是 `<secret:…>`，装了插件 verify 对 `replay serve` 全过】【实测 单测 `test/unit/replay-chain.test.ts`：JSON 叶子里的敏感头、HTML meta 里的令牌、插件明文里的令牌三种 verify 对 `replay serve` 都过，环境里没有任何 `TABCAP_SECRET_*`；换一个发新令牌的服务器，第二步发出的是新令牌】
  - (c) 无值的 query 键与业务编号：§15 两条。
- **`replay check --text`**：默认回 JSON 信封（与其它分析命令一致），`--text` 每条不是 `same` 的请求一行（id、方法、路径、状态、结果、哪里不同），最后一行合计；原来的 `--json` 去掉（默认表格 → 默认 JSON，未发布前不留兼容）。
- **`fetch` 的 `timing.ms` → `timing.totalMs`**（`POST /fetch` 同一信封；`_tabcap_fetch.py` 不读它）。
- **`ticket` 不是敏感名**（作者 10-17 定，规则仍为 `default@2`）：0.7-E 曾把它加进名单，因为同一张名单也决定 export-python 的 secret 输入，CAS 回跳 URL 里的票据会从常量变成要人填的值，当天去掉；`analyze chain --text` 的步骤 URL 仍按 §8.3 规则打码其它敏感参数。
- **`waiting` 的截图与 `status`**：guard 在交接后 0.4 s 才拍截图，而且要排在触发它的那条命令之后用标签，所以那条命令自己的 `waiting` 回答、紧跟着的 `status` / `handoff status` 都是 `screenshot: null`，约 0.5 s 后才有路径；截图本来就存在数据目录的 `shots/` 下，与有没有录制无关（`net stop` 之后 `status` 照样列出）【实测：复现脚本，`navigate` 到第 6 次的 403 验证页】。现在这三处都等正在拍的截图（最多 5 s）；`status` 的会话多 `url`、`handoff[]` 多 `url`、顶层多 `next`（§35）。验收报告里「没有录制时触发」与代码不符：guard 只看录制里的响应，没有录制不会进 `waiting`；当时看到的应是截图还没拍完【推断】。
- 验证：`bun test test/unit`、`bunx tsc --noEmit -p .`、`bun run validate:skill`、`bun run gen:docs`；e2e v06b、v06a、v07b、v04a、v03b、v06c 与 `tabcap.e2e`（结果见 NOTES 0.7-E）。

## 37. 0.7.1-A 人接管识别（10-17 作者定需求；字段与下列细节按实现定案，作者 2026-10-21 批量签收）

来源：公开仓库的第一次外部评审（10-17）指出，`03` §3 的「人可以随时接管」是论点里最重要、却没验证的一条：之前的交还都由工具触发（验证页、站点停手规则、显式 `handoff`），「人正在操作 AI 的标签」根本没有识别。作者定先做它，再做别的功能。

- **信号**：`direct` 模式下，会话的每个 owned 标签（新开的标签、owned 标签开出的弹窗；`Tabs.onTabAdded`）一加入就装一个被动监听器，装在 tabcap 自己的隔离世界 `tabcap-takeover` 里：`Runtime.addBinding {name:"__tabcapTakeover", executionContextName:"tabcap-takeover"}`（绑定只出现在这个世界，页面主世界里 `typeof window.__tabcapTakeover` 是 `"undefined"`【实测 spike-071a】），加 `Page.addScriptToEvaluateOnNewDocument {worldName:"tabcap-takeover", runImmediately:true}`（之后每个新文档和同进程的子帧都自动装上【实测 spike-071a：reload 后、同源 iframe 里都收到】）。监听 `pointerdown`、`keydown`、`wheel`、`touchstart`，捕获阶段、`passive:true`，只在 `isTrusted === true` 时报；不 `preventDefault`、不改 DOM、不改页面状态。报的只有事件种类与页面时刻 `{k, t, tr}`（`t` = `performance.timeOrigin + event.timeStamp`，毫秒取整），**不报键值、文本、坐标、目标元素**。同一种事件在页面侧 250 ms 内只报一次（滚轮、连续打字不刷屏；键入节奏也因此只剩 250 ms 的粒度；双击的第二次按下不另报）。只移动鼠标（`pointermove`）、焦点变化（`focus` / `blur`）、页面滚动（`scroll`）按设计不算。
- **不装的情形**：`config.json` `handoff.detectTakeover:false`（默认 `true`；不是布尔值时 `browser start` 回 `bad-input`；在 `browser start` 时读，改了要重启浏览器才生效）；`ext` 模式（还没有实现；做时先实测再开）。跨进程 iframe（OOPIF）里的输入不覆盖：它们是单独挂上的 `iframe` 目标，本格只装在标签自己的会话上【待验 / 已知盲区】。
- **排除 tabcap 自己的输入**：`DirectTransport.send` 对每条 `Input.*`（`click --trusted` 的鼠标路径与按下 / 抬起、`hover` 的移动、`type` / `fill --trusted` 的 `insertText` 与按键、`press-key`）发出前开一个窗口，收到答复（或报错、超时）时关上；窗口按 CDP 会话记，即按标签记（`src/daemon/transport/inputwindows.ts`）。监听器报来的事件，**到达守护进程的时刻**落在同一标签某个窗口的 [开始, 结束 + 500 ms] 里就忽略。理由【实测 spike-071a】：tabcap 自己经 CDP 发的输入在隔离世界里是 `isTrusted:true`，所以必须靠窗口排除；`pointerdown` / `keydown` 在答复之前到达，`mouseWheel` 的 `wheel` 在答复之后约 5 ms 才到，所以要 grace。页面自己 `dispatchEvent` / `el.click()` 出来的事件是 `isTrusted:false`，从不计。结束超过 5 s 的窗口丢掉。代价：人恰好在 tabcap 输入窗口里（含其后 500 ms）的输入不算；人继续操作时，下一次输入会算。
- **判定**（纯函数 `decideTakeover`，`src/daemon/browser/takeover.ts`，单测）：不可信 → 忽略；种类不在那四种里 → 忽略；落在窗口里 → 忽略（`tabcap-input`）；会话已经在 `waiting`（任何原因）→ 记成人的操作，不再触发；否则 → **接管**。
- **接管**：会话进 `waiting`，`reason:"human-takeover"`，与验证页同一套状态机（guard 的 `Handoff`）：动作命令（`BLOCKED_WHILE_WAITING` 那一组）回 `{code:"waiting", reason:"human-takeover", input:{event, at}, next, …}`，只读命令照常、带 `handoff` 字段；`tabcap status` 的会话行与 `handoff[]` 列出它（`--text`：`WAITING human-takeover at <url>`），顶层 `next` 对这种原因写「人在用这个标签：别动页面，人说做完后 `tabcap handoff continue --session <s>`」（不是「告诉用户」：人就在那儿）；`handoff status` 报告它。命令执行中撞上：命令照常走完自己的等待，然后回 `waiting`、原结果放 `error.result`（§18；不在 CDP 序列中途打断）。**不截图**（人正在这个标签上；后台标签截图可能要开焦点仿真，人看着的页面会短暂变化【推断】），`screenshot:null`。不冷却账号、不问 challenge 处理程序、不写 `guard` 事件；`origin` 不记，所以别的会话导航到同一源不受影响（验证页会拦）。trace 模式照 0.4-F 在等待期间暂停。
- **恢复**：只有 `tabcap handoff continue`（人说做完了。作者的「两边都能切换」是两边各有一个显式动作：人的一侧是动手，AI 的一侧是这条命令），不自动恢复、不按超时恢复。0.7.5-B 起也可由代理事先设好的条件结束（`handoff wait --until-*`，§39）。恢复后人的下一次输入会再次触发。
- **证据包**（录制时）：接管时写 `handoff {state:"waiting", reason:"human-takeover", question, timeoutMs:null, answerRef:null, request:null, url, screenshot:null, input:{event, at}}`（`actor:"system"`），紧跟触发它的那次输入的 `action`。会话等人期间（任何原因）监听器报来的每次人的输入都写一条 `action {tab, op:"input", event:"pointerdown"|"keydown"|"wheel"|"touchstart", at, target:null, value:null, phase:"done", error:null, shots:null, nav, trusted:true}`，`actor:"human"`、`cmd:null`（人的输入不是哪条 AI 命令引起的）；`at` 是页面时刻（epoch 毫秒）。等人期间、并且已经看到人的输入之后（§16 的「人在操作」状态），录制器的其余事件（请求、导航、console、signal）也标 `actor:"human"`；`handoff continue` 之后回到 `ai`。请求的 `actor` 按它**开始**（`requestWillBeSent`）时定，不按写入时：人点出来的请求在 `handoff continue` 之后才写入（如页面不读正文、§5.2 第 9 条晚 1 s 写）也仍是 `human`，AI 的导航在人接管后才完成的请求仍是 `ai`【实测 v071a 第一版：按写入时定时，人点出来、页面不读正文的 `/s62/ping` 在 `handoff continue` 之后写入，被标成了 `ai`】。验证页 / 停手规则的等待里人动手过验证，也按这一条标（§16 原本就这么定，之前没有信号）。`manifest.mode.humanRecorder` 在这份录制的浏览器装了监听器时为 `true`。
- **测试专用注入**（只为 e2e，不是产品功能）：守护进程启动时环境变量 `TABCAP_E2E_HUMAN=1`，才接受守护进程动作 `e2e.human-input {event?:"pointerdown"|"keydown", tab?}`，否则回 `usage`。它绕过 `DirectTransport.send` 的窗口（直接走 CDP 客户端），在焦点仿真下发一次 `Input.dispatchMouseEvent` 按下 / 抬起（视口 (4, 4)）或一次 Shift 的 `Input.dispatchKeyEvent`，也就是「tabcap 命令窗口之外来的一条可信输入」——测试造不出真实的 OS 输入。没有 CLI 命令，MCP 不列；只能经守护进程 socket 的 `POST /command`。
- **验证**：单测 `test/unit/takeover071a.test.ts`（窗口与 grace、判定表、载荷解析、配置、监听器源码只含那四种事件且不读键值）；e2e `test/e2e/v071a.e2e.test.ts`（靶场 s62，`05` §12）。
- 【待验】真人的 OS 输入：本格只能用 CDP 注入模拟。真人的鼠标、键盘、触控板是否同样 `isTrusted:true`、到达守护进程的时延、拖动滚动条（视口滚动条与元素滚动条）、浏览器自动填充、输入法组合、Chrome 自己的快捷键会不会出现在页面的 `keydown` 里，都没有由人在本机实际操作量过（`07` §1.1）。

## 38. 0.7.5-A 列表结束 `endOn`（10-20 作者定需求；字段与下列细节按实现定案，作者 2026-10-21 批量签收）

来源：真实项目抓取（10-20）。站点停手规则是 `json:$.code!=0`，翻到第 21 页时接口回 `{"code":203,…}`（意思是「没有更多了」），规则命中，整个站点停手、会话进 `waiting`，要人来 `guard resume`。作者定：这类返回码标成「列表结束」，**命中只结束当前这一次请求，站点照常可用**。

- **配置与参数**：`config.json` `sites.<站点名>.guard.endOn: [规则…]`（与 `stopOn`、`consecutiveNon200` 同一对象；只配 `endOn` 也算这个站点有 guard 设置）；`tabcap fetch --end-on <规则>`（可重复，≤ 32 条）、`--batch` 行与 `POST /fetch` 的 `endOn`、Python 客户端 `fetch(..., end_on=[…])`。规则语法与 `--stop-on` 相同（§26）。一条响应的结束规则 = 站点的 `guard.endOn` + 这次调用的 `--end-on`，按序取第一条命中的。坏规则：配置里的 `net start` / `fetch` 回 `bad-input`，命令行的回 `usage`。
- **先于停手判定**：结束规则命中的响应**不再跑任何停手规则**——站点的 `guard.stopOn`、`fetch.stopOn`、`--stop-on` 都不跑；`consecutiveNon200` 计数把它当正常响应（归零，不管 HTTP 状态）。正文类结束规则（`empty-body`、`json:`、`text:`）同停手规则一样只在正文确知时求值（§18 后的 0.6-I 段）。
- **`tabcap fetch` 的回答**：`ok:true`，信封照常，多一个 `end:{rule, detail}`（`detail` 与 `stopped` 同样是一行说明，如 `$.code is 203`）。不写 `stopped`，不停站点，会话不进 `waiting`。`--batch`：这一行回带 `end` 的成功信封，**后面的行照样发**（batch 是作者事先写好的固定请求表，不是翻页循环；要在列表结束处停，用逐条 `fetch` 或 Python 客户端）。
- **Python 客户端**（`templates/python/_tabcap_fetch.py`）：回答带 `end` 时抛 `ListEnd`（`Exception` 的子类，不是 `Stopped`），带 `rule`、`detail`、`status`、`headers`、`content`；翻页循环 `except ListEnd: break`。没配结束规则的旧用法不变。
- **页面自己的请求**（人或 AI 点「下一页」）：站点 `guard.endOn` 命中时同样不跑停手规则、计数归零，录制里记一条 `guard` 事件（下条），不影响页面，不拦命令。
- **证据包**：每条结束规则命中的响应写一次 `guard {event:"end", site, account:null, rule, request:"r-N", detail:{rule, detail, request, url, status[, fetchId]}}`（同一请求只写一次；`site` 是库站点名，`fetch` 不在库站点下时是 URL 的主机，同 §26）。不写 `breaker`、`handoff`。
- **验证**：单测（规则解析、配置、guard 判定先后与计数、fetch 回答、batch、端点、Python 客户端）；e2e `test/e2e/v075a.e2e.test.ts`（靶场 s64，`05` §14）。

## 39. 0.7.5-B 交接按条件自动结束 `handoff wait --until-*`（10-20 作者定需求；字段与下列细节按实现定案，作者 2026-10-21 批量签收）

来源：真实项目抓取（10-20）。作者在 tabcap 的浏览器里点了一下，会话进入 `human-takeover`；登录完成后，作者对主循环说「登好了」，但后台子代理收到的是转述，不能当作者本人的确认，又没法弹权限确认，流程卡住。作者定（10-20，原话「我明确同意改成『代理事先设好、客观可查的条件满足了也算』」）：**交接除了人说做完、AI 执行 `handoff continue` 之外，也可以由代理事先设好的、客观可查的条件结束。**

- **命令**：`tabcap handoff wait [--until-url <子串>] [--until-text <文字>] [--until-selector <css>] [--until-cookie <名字>] [--timeout ms] [--session s]`。每个 `--until-*` 至多一个，给了几个就是「任一满足」。不给 `--until-*`：只等人（`handoff continue` 从别处执行了，或 challenge 处理程序回答了），与 MCP 原来的 `tabcap_handoff_wait` 相同。`--timeout` 默认 60000，范围 100–600000。
- **适用的等待**：`verify-page` 与 `human-takeover`。`stop-rule` 的等待要人看过响应再判断，给 `--until-*` 回 `usage`（不给则照样只等人）。会话不在等待：立刻回答当前状态（`state:"running"` 或 `"resumed"`、`handoff`），什么都不等。
- **条件看哪里**：交接所在的标签（`handoff.tab`）。`--until-url`：标签当前 URL 含这个子串（导航事件唤醒，另外每 250 ms 看一次）。`--until-text`：标签各帧的可见文字含它（同 `wait --text` 的求值）。`--until-selector`：主帧有元素匹配（同 `wait --selector`；选择器无效回 `usage`）。`--until-cookie`：`Network.getCookies` 对标签当前 URL 返回的 cookie 里有这个**名字**（只比名字，**值不读出、不输出、不记录**）。text / selector / cookie 每 250 ms 查一次。
- **必须是交接之后才变成立的**（防止「一开始就成立」直接放行）：每个条件要在这次交接里先见过「不成立」，之后的「成立」才算数。URL 与 cookie 在交接开始时就记一次基线（交接开始时标签的 URL；那时标签 URL 对应的 cookie 名字集合），基线里不成立就算见过，所以人先做完、`handoff wait` 后到也能认出；text 与 selector 没有基线，从 `handoff wait` 第一次查看起算，同一次交接里多次 `handoff wait` 共享这份记录。**所有**给出的条件第一次查看就已成立、又没见过不成立时，立刻回 `waiting` 错误（`next`：条件一开始就成立，证明不了人做完了；问人，人说做完再 `handoff continue`，或换一个只有做完才会出现的条件）。部分条件已成立时，只等其余的。
- **满足时**：与 `handoff continue` 相同的收尾——会话 `resumed`、绑定账号清掉 `needs-human`、站点会话存进库（`storeSession`）；**不同之处**：不解除该会话引起的 fetch 停手（那要人判断响应），仍停着的在回答里列为 `guardStops`。回答 `{session, state:"resumed", by:"condition", condition:{kind:"url"|"text"|"selector"|"cookie", value, …}, waitedMs, handoff, storeSession, account?, guardStops?}`；`kind:"cookie"` 的 `value` 是名字。等待中人从别处 `handoff continue` 了：回 `{state:"resumed", by:"human", …}`。超时：`waiting` 错误，`next` 说再跑一次 `handoff wait` 继续等，或人说做完后 `handoff continue`，带 `waitedMs` 与 `handoff`。
- **证据包**：`handoff {state:"resumed", reason, question:null, timeoutMs:null, answerRef:null, by:"condition", condition:{kind, value}}`（§4.2）。条件的查看本身不写事件。
- **MCP**：`tabcap_handoff_wait` 加 `untilUrl`、`untilText`、`untilSelector`、`untilCookie`，改为一次调用 `handoff wait`（`timeoutSeconds` 照旧 0–300，默认 30）。`handoff wait` 不进 MCP 的通用表（`tabcap_run` 也不收），只经 `tabcap_handoff_wait`。
- **它不改什么**：`human-takeover` 与 `verify-page` 仍不按超时恢复；没有 `handoff wait --until-*` 在跑、也没有人说做完，会话一直等。§37「只有 `handoff continue`」一句由本节放宽。
- **给代理的用法**（技能说明）：撞上 `waiting` 先告诉人要做什么，再跑 `handoff wait`，条件挑「只有人做完才会出现」的（登录后的 URL、登录后才有的 cookie 名）；子代理撞上 `waiting` / `guard.stopped` 时向派它的代理汇报，不自己 `handoff continue` / `guard resume`，转述来的「人说好了」不算数——由直接和人对话的那个代理执行，或用 `handoff wait --until-*`。
- **验证**：单测（参数、基线与「先见过不成立」、各原因、竞态、MCP 参数）；e2e `test/e2e/v075b.e2e.test.ts`（靶场 s65，`05` §14）。
- 【待验】真人登录：靶场里人的输入用 `e2e.human-input` 模拟（§37）；跨域单点登录把 cookie 种在别的域、`Network.getCookies` 按标签 URL 看不到的情形，没在真实站点上量过。

## 40. 0.7.6-A 默认隐藏 `navigator.webdriver`（10-20 作者定需求；字段与下列细节按实现定案，作者 2026-10-21 批量签收）

来源：作者 10-20 改项目要求，「要求默认隐藏 webdriver」，选方案 A（启动参数，不注入脚本）。此前 `docs/10` 写着「不隐藏 webdriver」，一并删去。

- **怎么做**：`direct` 模式启动 Chrome for Testing 时多传 `--disable-blink-features=AutomationControlled`（pipe 与 port 两种连接都传）。不往页面注入脚本、不改 getter：`Navigator.prototype.webdriver` 仍是原生 getter，只是返回 `false`。【实测 10-20】见 `07` §1.2 末注。
- **开关**：`tabcap browser start --webdriver hidden|visible`，默认 `hidden`；`config.json` 顶层 `"webdriver": "hidden"|"visible"` 作默认值（`--webdriver` 优先）。其他值回 `usage`。`visible` 时不传这个参数，`navigator.webdriver` 回到 Chrome 自己的值（pipe 下为 `true`）。
- **输出里标明**：`browser start` / `browser status` 的回答带 `webdriver:"hidden"|"visible"`；`tabcap status` 的 `browser` 带 `webdriver`（浏览器没在跑为 `null`），`status --text` 的守护进程行在标签数后写 `webdriver <值>`；证据包 `manifest.producer.browser.webdriver`（§7），旧包没有这个字段。
- **不管的**：`ext` 模式接管作者自己的 Chrome，不是 tabcap 启动的，本节不改它，值未量【待验】。只隐藏这一个信号：CDP 连接本身的痕迹、Chrome for Testing 自身的特征、其他指纹都不处理。线指纹画像（`11`）的缓存按启动参数哈希失效，换参数后第一次 `wire probe` 重新采集。
- **验证**：单测（`buildArgs` 默认带、`visible` 不带；`--webdriver` / `config.json` 的解析与报错；manifest 读写；`status --text`）；e2e `test/e2e/v076a.e2e.test.ts`（靶场 s66，`05` §15）。

## 41. 0.8-A 防护家族识别（10-20 作者定需求；已实现（0.8.0），作者 2026-10-21 批量签收）

来源：作者 10-20「不做针对和绕过，但是家族化模式识别流水线可以搞……至少要让用户或者说 agent 知道碰到的是啥」；同日定：规则自己从公开来源写、本地对照 scrapfly/Antibot-Detector（NPOSL-3.0，代码与规则数据不进仓库，只学思路和方式）、**三层都做**、家族面向 Antibot-Detector 看齐。家族清单与来源见 `docs/14`。recon v0（§22）的 `PROTECTION_SIGNALS` 里三条厂商头名（`cf-mitigated`、`x-amzn-waf-action`、`x-datadome`）并入本节的规则表；`x-iinfo`（Imperva，来源偏弱、不进表，`docs/14` §5）与限流 / HTML 403 等通用信号照旧留在 `PROTECTION_SIGNALS`。

- **只识别**：回答「这里碰到的是哪家、凭什么这么说」。不给绕过提示，不分析对方脚本的算法，不估「难度」（Antibot-Detector 的 difficulty 是给绕过用的，不学），不提供针对某家的工具（它的 Advanced 一栏不学）。认出来以后照旧：挑战交给 guard / 人。

### 41.1 规则文件 `tabcap-protection/0`

- 一家一个 JSON。内置的在 `src/analyze/protection/families/<id>.json`（打包进二进制）；用户的在 `config/protection/<id>.json`，同 `id` 覆盖内置、新 `id` 追加。用户文件按不可信输入校验（未知键拒绝、大小 ≤ 32 KB、正则编译失败报错并点名文件与字段），坏文件跳过并在回答的 `warnings` 里列出，不影响其他家族。
- 顶层：`{schema:"tabcap-protection/0", id:<kebab>, name, vendor, category:"anti-bot"|"captcha"|"fingerprint", version:<正整数>, sources:[{url, note?}](内置必填), rules:[…], combinations?:[…]}`。
- 规则：`{id, kind, confidence:1–100, standalone?:true, note}` 加按 `kind` 的匹配字段；层由 `kind` 决定（0.8-A1 实现定：不另写 `layer`，免得两处不一致）：
  - L1（录到的流量，或实时的 cookie 名 / 资源 URL）：`cookie {name, nameRegex?, valueShape?}`（`valueShape` 是对值的正则，只用于判断形状，**值从不输出**）；`request {url}`（正则对完整 URL，主机 + 路径；可加 `type`、`method`）；`responseHeader {name, value?}`；`requestHeader {name}`；`challenge {status?:[…], text?}`（只对 document / HTML 正文，`text` 正则，正文截 64 KB 求值）；`requestBody {url?, text}`（POST 正文里的字段名，如 `g-recaptcha-response`）。
  - L2（页面上，只读）：`global {path, condition:"exists"|"function"|"object"|"string"}`（主世界里沿 `path` 逐段读**自有属性描述符**判断，不调用 getter；遇到访问器只算 `exists`）；`dom {match, has?}`（沿用适配器的 ElementSpec：tag / id / classPrefix / attr，`docs/09` §9）；`frame {url}`（iframe 的 src 正则）。
  - L3（追踪模式）：`api {target, caller?}`（`target` 是追踪 `signal` 的 API 名，`caller` 是对调用方脚本 URL 的正则，可省）。
- 组合：`{id, name, confidence, when:{all|any:[{rule:<id>}|{all|any:[…]}]}}`，可嵌套。
- **置信度原则**（学 Antibot-Detector 的定法，用我们自己的话写进单测）：只有该厂商才会产生的信号才能单条 100（厂商自有的主机、厂商自创的 cookie / 头名；短名字如 `TS`、`v`、`_px` 必须带 `valueShape` 才行）；页面标记、全局变量、源码文字和与别家共用的信号单条至多 90（anti-bot）/ 60（captcha）；`standalone:false` 只在组合里计分；组合只有每个分支都是厂商专有信号时才能到 100，其余 ≤ 95。来源强度为「弱」或「无」的家族不进内置表（作者 10-20，`docs/14` §5）。家族得分 = 命中的 standalone 规则与成立的组合里的最大值。单测逐条检查内置规则是否守这些上限。

### 41.2 识别与输出

- 纯函数 `identify(evidence, families) → Detection[]`。证据：`{cookies:[{name, value?}], requests:[{id, url, method, type, status, requestHeaders, responseHeaders, body?, postData?}], globals:{<path>:"function"|"object"|"string"|"accessor"|…}, dom:<适配器 digest>, frames:[url], api:[{target, caller}]}`，各项可缺（缺的那层不评）。
- `Detection`：`{family, name, vendor, category, confidence, layers:[1|2|3], matched:[{rule, layer, kind, where}], grade:"推断"}`；`where` 只有指向：请求号 `r-N`、cookie **名**、头**名**、全局路径、选择器、API 名与调用方 URL——cookie 值、头值、正文从不出现在输出里。按置信度降序，置信度 < 30 的不报。
- L3 的指纹技术（`category:"fingerprint"`，0.8-A1 内置 10 类：canvas、WebGL、navigator、硬件、屏幕、时区 / Intl、媒体设备、权限、语音、字体——只用追踪模式默认名单里的 API；音频、WebRTC、电量等要先扩追踪名单，待作者定）另报：`{technique, apis:[…], callers:[{url, count}], attributedTo?:<家族 id>}`；调用方脚本命中某家族的 L1 `request` 规则时归因。

### 41.3 数据从哪来、在哪里报

- **离线（证据包）**：`tabcap recon` / `tabcap analyze recon <包>`。L1 来自包里的请求、响应头、`state` 事件的 cookie 名、document 正文；L2 只能从录到的主文档 HTML 里认 `dom` / `frame`（`global` 离线不评）；L3 来自开过追踪的包里的 `signal` 事件。`dossier.json` 的 `protection` 加 `{source:"family", …Detection}` 条目，`fingerprinting:[…]` 另列；`dossier.md` 的 Protection 一节先列家族，再列原有的 guard 与通用信号。
- **实时（不录制也有）**：`navigate` / `tab new` / `go` / `reload` 的就绪等待与稳定等待之后，对该标签做一次轻量探测（`src/daemon/protection/`）：`Network.getCookies`（标签 URL；值只用来判断形状）、隔离世界里读资源计时表与 `<script src>` / `<iframe src>`、主世界沿属性路径读**描述符**判断 L2 全局（访问器只记 `accessor`、不调用、不深入）、隔离世界的 DOM digest。不开 `Network.enable`，不注入页面脚本。结果按标签与导航次数（`navEpoch` + URL）缓存，同一次导航只探测一次；`snapshot`、`status`、guard 都读这份缓存。0.8-A2 实现定：录制中也**不**在每次导航时重扫整个包取响应头与状态（太重），完整 L1（头、状态、挑战页正文）只在 `recon` 里；实时提示靠 cookie 名、资源 URL、全局变量与 DOM。
- **报给 agent**：`navigate` / `tab new` / `go` / `reload` / `snapshot` 的回答在识别到置信度 ≥ 50 的家族时加 `protection:[{name, category, confidence}]`（只名字与分数，细节去 `recon`；指纹技术需要追踪模式，不在实时提示里），没有就不出现这个字段；`status` 的每个会话带 `protection:[name…]`（当前标签，只读缓存），`status --text` 的会话行末加 `· protection <名…>`；guard 交接（stop-rule / verify-page / human-takeover）时，`Handoff.protection` 先取缓存，缓存为空（交接发生在导航途中、探测还没跑）就在拍交接截图的同一步里、按标签的轮次补做一次探测，回答本来就等截图（≤ 5 s），所以也等到家族名；`handoffView` 带 `protection`，`next` 以 `This is <家族 + 家族> (identified, not bypassed; a human handles it). ` 开头；`guard breaker` 与 `handoff waiting` 事件带 `protection`（breaker 写在截图之前，可能还没有）。证据包：识别结果（非指纹家族及其分数）在一个标签上变化、且会话在录制时，写一条 `protection {tab, nav, url, detections:[{family, name, category, confidence, matched}]}` 事件（§4.2 新 kind；`matched` 只有指向，没有值）。
- **追踪模式**：只有 `trace start` 开着才有 L3；`trace stop` 时把本次窗口的指纹技术汇总写进 `protection` 事件。

### 41.4 本地对照与验证

- 本地对照（作者 10-20 定：脚本只留本地，绝对不进仓库、不推远端）：用作者本机的 Antibot-Detector 检出跑同一个包，只看「一致 / 只有 tabcap / 只有 Antibot-Detector」的家族名。不一致时回到公开来源补规则（`docs/14` 的来源规则），不照抄。
- 单测：规则文件的校验与报错、置信度上限、每条内置规则都有 `sources`、`identify` 的各层与组合、值从不出现在输出里（含 `valueShape` 命中的 cookie）、用户文件覆盖、坏文件只跳过自己。
- e2e：靶场 s67–s70（`05` §16），厂商主机经 `fwdproxy` 映射到本机，页面里只有我们自己写的桩脚本与名字，不放任何厂商代码。
- 【待验】真实站点上的命中率与误报：靶场只能证明匹配逻辑；`docs/14` 每条要在作者真实项目的包里见到才改【实测】。

## 42. 0.8.1-A 自定义 Chrome 启动参数（10-21 作者定需求与方案）

来源：作者 10-21 实际使用中要给 Chrome for Testing 加自己的启动参数，tabcap 写死了参数表、没有透传口子。作者定：「不影响实际使用和操作的全部不拒绝」；删除 tabcap 默认参数（dropArgs）一起做；证据包 manifest 记 `browser.args`。

- **入口**：`tabcap browser start --chrome-arg <arg>`（可重复，加或覆盖）与 `--drop-chrome-arg <arg>`（可重复，删 tabcap 的默认参数）；`config.json` `chrome.args` / `chrome.dropArgs`（字符串数组）作默认值，命令行的排在配置之后。`tabcap setup` 改写 `chrome` 时保留这两个键。配置里不是字符串数组回 `bad-input`，点名键。不加环境变量（按空格切分有引号歧义）。
- **每项的形状**：`--name` 或 `--name=value`（名字以字母或数字开头，`[A-Za-z0-9._-]`）；不以 `--` 开头的（URL、单横线写法）回 `usage`：它不是开关，开页面用 `navigate` / `tab new`。
- **只拒绝会让 tabcap 自己失灵的**（`usage`，浏览器不起来）：
  - 加：`--user-data-dir`（profile 由 tabcap 管：池账号 cookie、port 模式的 `DevToolsActivePort`）、`--remote-debugging-pipe`。
  - 删：上面两个，再加 `--remote-debugging-port`（port 模式靠它）。
  - `--proxy` 不是 `system` 时再加代理开关（`--proxy-server`、`--proxy-bypass-list`、`--proxy-pac-url`、`--no-proxy-server`、`--proxy-auto-detect`）：两处代理互相打架，用其中一个。`--proxy system` 时可以加，此时回答的 `proxy` 为 `"chrome-arg"`。删的方向同样（10-21 审查后作者定）：`--proxy` 不是 `system` 时 `--drop-chrome-arg` / `chrome.dropArgs` 命中这五个开关之一也回 `usage`，`next` 与加的方向相同；否则删掉 tabcap 为 `none` / `<url>` 设的 `--proxy-server` 后浏览器改为直连，回答的 `proxy` 却仍写 `none` / URL。
  - 其余一律照传，包括 `--remote-debugging-port=<n>`（pipe 模式下另开一个调试端口，本机任何进程都能连上浏览器，由用户自己决定）、`--headless`、`--user-agent`、证书相关参数。
- **合并规则**（纯函数，`launcher.ts` `applyCustomArgs`；Chrome 对重复开关只认最后一个）：
  1. 先删：`--drop-chrome-arg --name` 删掉所有同名开关；`--name=a,b` 对逗号列表开关（`--enable-features`、`--disable-features`、`--enable-blink-features`、`--disable-blink-features`、`--load-extension`）只从列表里删这几项（列表空了整条去掉），对其他开关只删完全相同的那一条。什么都没删到的记进 `dropArgsUnmatched`，不报错（同一份配置在不同平台上用，比如 Linux 没有 `--use-mock-keychain`）。
  2. 再加：逗号列表开关把用户的项并进 tabcap 已有的那一条（同名项用户的替换 tabcap 的，按特性名比较，`Name:参数` / `Name<Trial` 只看 `Name`）；`--enable-features=X` 同时把 X 从 `--disable-features` 里拿掉，反过来也一样（blink 两条同理），所以用户能打开 tabcap 默认关掉的特性。不带值的列表开关（`--disable-features`、`--disable-features=`）不加任何项，tabcap 的那一条照旧（PR #27 Bugbot）。其他开关与 tabcap 同名时用户的替换 tabcap 的；不同名的追加在开关末尾（`about:blank` 这类位置参数之前）。用户自己重复写同一个非列表开关，只留最后一个。
  3. `webdriver` 的值由最后的命令行推出：`--disable-blink-features` 里有 `AutomationControlled` 为 `hidden`，否则 `visible`（例如 `--drop-chrome-arg --disable-blink-features` 或 `--chrome-arg --enable-blink-features=AutomationControlled` 让它变成 `visible`）。
- **输出里标明**：`browser start` / `browser status` 的回答带 `args`（实际命令行，不含可执行文件路径）、`extraArgs`、`dropArgs`、`dropArgsUnmatched`；浏览器已在跑、这次请求的自定义参数与正在用的不同时，回答 `alreadyRunning:true` 加一条 `note`（先 `browser stop` 再 `start` 才生效）。`tabcap status` 的 `browser` 带 `extraArgs` / `dropArgs`（浏览器没在跑为 `null`），`status --text` 在有自定义参数时于 webdriver 后写 `chrome args +<加的条数> -<删的条数>`。
- **manifest**：`producer.browser.args`（实际命令行）、`extraArgs`、`dropArgs`。与 `wire` 画像缓存同一套规整（`src/wire/profile.ts` `normalizedFlags`）：`--user-data-dir=<profile>`、`--load-extension=<extension>`，本机路径与用户名不进包；再做已知秘密值替换。旧包没有这三个字段 = 未记录（当时是默认参数表）。
- **不管的**：`ext` 模式（作者自己的 Chrome）不是 tabcap 启动的，不受影响。参数改了页面行为（比如重新打开 bfcache 让录制缺事件）由用户负责，tabcap 只把参数标出来。线指纹画像的缓存本来就按启动参数哈希失效（§40 末条）。
- **验证**：单测（`applyCustomArgs` 的删、合并、覆盖、相反列表、位置参数顺序、`dropArgsUnmatched`；`checkCustomArgs` 的拒绝项与代理冲突；`config.json` 的解析、报错与 `setup` 保留；manifest 写入与规整；`status --text`）；e2e `test/e2e/v081a.e2e.test.ts`（靶场 s71，`05` §17）。
