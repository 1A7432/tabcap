# 输入保真：click / type 的事件形状（提案，待审）

2026-10-15。0.3-D 第二部分。本格**只出提案**，不写码：按 `AGENTS.md`，CLI 语义改动要先提案、作者审过才能实现；expected 只来自本地探针（oracle）实测；靶场先加场景再开工。本文给出 `docs/07` §1.1 要加的行、`docs/05` 要加的场景、`docs/06` 要加的验收、CLI 的精确语义变更，以及在本机重跑的 oracle 证据。`docs/05`、`06`、`07` 本身不动，作者审过后再合并进去。

标注：【实测】本格亲自跑过（日期、命令、版本见 §2.1）；【推断】间接推出；【待验】没验证。

## 0. 一屏要点

- **重跑结果改写了一条前提**【实测】：Playwright `page.click` **不是轨迹**，只是**一条** `mouseMoved` 直接落到目标点（无头运行时 pointerdown 之前恰好 1 个 pointermove 和 1 个 mousemove，坐标与 pointerdown 相同），按下到抬起间隔 0.2–0.5 ms。NOTES 里 `movementX/Y = -281,-145` 这组非零值，是有头窗口下系统真实光标的位置造成的：这次重跑同一模式得到 `-769,-281`，无头为 `0,0`。也就是说，规格第 1 条（≥25 点/秒、0.1–0.4 s 轨迹、50–140 ms 按压间隔）**比 Playwright 更像真人**，事件**结构**与 Playwright 同形，事件**数量与节奏**不同形。按这个规格实现后，与 Playwright 逐字段 diff 时，move 条数和时间间隔两项必然不同，这是规格的本意，不算缺陷。验收需要区分「结构字段」和「节奏字段」（§7）。
- **tabcap 现状**【实测】：默认的 DOM 点击路径只有 1 个 `click` 事件，`isTrusted=false`、坐标 0,0、`detail=0`。`--trusted` 路径的 7 个指针事件全部可信，但 pointerdown 之前 **0 个 move**，与 DrissionPage 默认点击同形（光标瞬移）；另有一处字段差异：pointerdown 的 `pressure` 为 0，Playwright 为 0.5。`type` 只发一次 `Input.insertText`（beforeinput / textInput / input 各 1 个、没有按键事件），与 Playwright 的 `fill()` 同形，与 `type()` 不同形；`type()` 每个 ASCII 字符产生 keydown / keypress / beforeinput / textInput / input / keyup 6 个事件，全部可信。
- **建议**：
  1. `click` 默认改走第二级，带轨迹。
  2. DOM `el.click()` 改名为 `--dom`，输出标「事件序残缺」，不删除。
  3. `--trusted` 保留一版，作为无操作的别名。
  4. `type` 改成逐键：有键位的字符走 `Input.dispatchKeyEvent`，没有键位的字符（中文、emoji）逐字走 `insertText`，与 Playwright 实测一致；旧行为改为显式 `--insert`。
  5. 节奏字段（每键间隔、轨迹时长）的「真人下限」现在没有 oracle，建议由作者在探针页手点、手打一次作为 L3 oracle（§7 A7.9），实现前补齐。
- **待作者定**：见 §9，共 7 条。

## 1. 作者规格（原文照录）

> 以下为作者给出的规格原文，未改一字。

---
【任务】把 tabcap 的 click / type 的「事件形状」从残缺补到真人输入下限。不是反检测军备：不伪装指纹、不对任何站点做对抗；目标是自动化输入的事件序列与真人 / Playwright 同形。遵守 AGENTS.md：设计先提案（本格改 CLI 语义，必须先出提案过审再写码）、expected 只来自本地探针 oracle 实测、靶场先加场景（范围规则：没有场景不开工）。

【oracle——先读，不要重新发明】
1. NOTES「探针 · DrissionPage 与 Playwright 点击语义对比」格 + /tmp/tabcap-probe/reports/ 的 11 次本地实测：Playwright 的 page.click 在 pointerdown 前有真实 move 链到达目标点（movementX/Y 有值，13 事件）；DrissionPage 默认无 move（光标瞬移）；by_js / evaluate 的 click 是 isTrusted=false；通用静态指纹（webdriver、plugins、CDP 探针）两边并无差异——事件序才是本格要补的主变量。
2. 上述结论只来自本地探针页；真实站点行为永远超出本格范围（不实测任何第三方站点，也不引用任何站点侧结论）。
3. NOTES spike 2 格（硬约束）：未绘制的隐藏标签上 CDP mouseMoved 永不返回；焦点仿真（第二级）让页面 visible 后 CDP 输入可信。二级的代价与降级路径沿用既有阶梯设计。

【规格——提案逐条过审】
1. click（--trusted 路径）：连续 Input.dispatchMouseEvent(type=mouseMoved) 插值轨迹（≥25 点/秒、总时长 0.1–0.4s、终点=目标坐标、可选 ±0.4px 散布）→ mousePressed(clickCount=1) → 50–140ms 随机缺口 → mouseReleased。pointerover/enter/pointerdown/up 与 mouse 系列由 Chrome 输入管线自动合成，保持 isTrusted=true；禁止手写 DOM click / dispatchEvent 路径充当 trusted 行为。
2. 现默认的 DOM el.click()（isTrusted=false）必须在提案里处置：删除，或改名 --dom 并在 CLI 输出标注「事件序残缺」。
3. typing：先在探针页测 Playwright type() 的逐键事件序作 oracle（keydown/keypress/input/keyup 的形状与节奏），对照现状 insertText（一次性、无 key 事件）的差异再定规格；expected 一律来自探针导出，不推理。
4. 与焦点阶梯整合：拟真轨迹依赖页面 visible（第二级）；一级路径不发轨迹并在输出注明「事件序残缺」；隐藏标签必须走阶梯，绝不对未绘制标签发 mouseMoved（会挂起）。
5. 失败语义：任何异常响应（4xx、空体、挑战页）都不得自动重试或连发；具体熔断实现属 guard 格，本格提案里只写交界说明。给运行时行为打补丁的通用教训（作者已付过学费）：一切包装/拦截必须在实例方法层做——代理/委托层永远接不住内部自调用。

【验收（docs/06 先写测试）】
改后在本地探针页：pointerdown 前 ≥1 条 move 且终点坐标差 ≤1px；全事件 isTrusted=true；隐藏标签按阶梯降级、不挂起；事件序与 Playwright 基线逐字段 diff 列进报告（用现有 probe.html）；L0/L2 全绿。docs/05 先加「拟真点击」场景，/tmp/tabcap-probe/probe.html 升格为靶场夹具后再实现。

【交付顺序】提案（docs/07 参数表行 + docs/05 场景 + docs/06 验收）→ 作者审 → 实现 → 对拍报告 → NOTES 三行收尾。禁止顺手改 guard / 回放 / HAR 语义。
---

## 2. oracle 复测（本机，本格亲自跑）

### 2.1 环境与做法【实测】

- 2026-10-15，macOS arm64。浏览器统一用 Chrome for Testing 155.0.8059.79（本会话 scratchpad `cft/`，即 brief 里的 TABCAP_CHROME），Playwright 1.64.1，DrissionPage 4.1.1.4。作者原矩阵的 meta 记录用的是品牌版 `/Applications/Google Chrome`；这次换成 CfT，事件形状与原矩阵一致（见 §2.2）。
- 探针页：`/tmp/tabcap-probe/probe.html` 的副本，只把上报端口从 8791 改成 8792，放在本会话 scratchpad `part2/`，原目录没有改动。打字另用一份副本 `probe-type.html`：加一个 `<input id=field>`，记录 `keypress`、`beforeinput`、`textInput`、`composition*`，以及 `inputType`、`data`、`keyCode`、`charCode`、`repeat`、`location` 等字段。
- 驱动脚本：`run_playwright.mjs` 与 `run_drission.py` 的副本，加了 `PROBE_HEADLESS=1` / `--headless` 开关与打字模式（`type` / `press_seq` / `fill` / `press_enter`，文本 `"aB3 中"`）。命令形如 `node run_playwright.mjs click --browser <CfT>`、`python -I run_drission.py default [--headless] --browser <CfT>`。只访问 `127.0.0.1:8792`。
- tabcap 基线：用 `git worktree` 检出 HEAD `4513124`（与 Part 1 并行开发的代码隔离），`TABCAP_HOME` 放在 scratchpad 下；命令 `browser start --proxy none` → `navigate` → `find 默认框` → `click <ref>` / `click <ref> --trusted`；打字页依次跑 `click --trusted` 字段 → `type "aB3 中"` → `press Enter`，以及 `fill`、`fill --trusted`。另用 `navigate --new-tab` 开第二、第三个后台标签（`visibilityState` 为 `hidden`），分别跑 `--trusted` 和 DOM 点击。跑完 `daemon stop`，worktree 已删除。
- 汇总脚本 `analyze.py` 在 scratchpad `part2/`，报告 JSON 在 `part2/reports/`。提案过审后，这些文件按 §6 升格进 `fixtures/`。

### 2.2 点击【实测】

「到 click 为止」只数从页面第一个事件到 `click` 的事件；「move 数」是 pointerdown 之前 pointermove 与 mousemove 的合计；「间隔」是 mousedown 到 mouseup。

| 运行 | 到 click 为止 | pointerdown 前 move 数 | 最后一个 pointermove 到 pointerdown 的距离 | 目标点那个 move 的 movementX/Y | 全部 isTrusted | click.detail | 间隔 |
|---|---|---|---|---|---|---|---|
| Playwright `click`，无头 | 9 | 2（1 pointermove + 1 mousemove） | 0 px | 0,0 | 是 | 1 | 0.2 ms |
| Playwright `click`，有头 | 13 | 4（前 2 个在真实光标处 940,466） | 0 px | −769,−281 | 是 | 1 | 0.5 ms |
| DrissionPage `default`，无头 | 7 | 0 | — | — | 是 | 1 | 0.9 ms |
| DrissionPage `default`，有头 | 11 | 2（都在真实光标处 943,483，离目标 828 px） | 828 px | — | 是 | 1 | 0.7 ms |
| Playwright `evaluate(el.click())` / DrissionPage `by_js=True` | 1（只有 click） | 0 | — | — | **否** | 0 | — |
| tabcap `click`（第一级 DOM） | 1（只有 click） | 0 | — | — | **否**（坐标 0,0） | 0 | — |
| tabcap `click --trusted`（第二级） | 7 个指针事件（另有焦点仿真引起的 2 个 focus） | **0** | — | — | 是 | 1 | 6.1 ms |
| tabcap `--trusted`，隐藏的后台标签 | 7 | 0 | — | — | 是（点击时 `visible`、`hasFocus:true`） | 1 | 1.5 ms |
| tabcap DOM 点击，隐藏的后台标签 | 1 | 0 | — | — | 否（`hidden`） | 0 | — |

观察：
1. 【实测】Playwright 无头的完整序列：`pointerover > mouseover > pointermove > mousemove > pointerdown > mousedown > pointerup > mouseup > click`，即**单个** `mouseMoved` 打到目标点后立即按下。
2. 【实测】有头运行开头那组 `pointerover / pointermove` 在真实光标坐标上，无头运行里没有；movementX/Y 是相对这个点算的，所以每次都不同（原 NOTES 记的是 −281,−145，这次是 −769,−281）。【推断】来源是窗口出现在系统光标下面，与工具无关。所以 oracle 应该取无头运行，或者在有头运行里剔除第一个由工具发出的事件之前的所有事件。
3. 【实测】tabcap `--trusted` 与 DrissionPage 默认点击同形，只有 `pointerover → down`，目标点上没有 move。
4. 【实测】逐字段 diff（tabcap `--trusted` 对 Playwright 无头；忽略 `timeStamp`、`dt` 和随窗口位置变化的 `screenX/Y`）：pointerdown 的 **`pressure` 为 0，Playwright 为 0.5**；`clientY` 相差 0.02 px（185.95 对 185.93）；`button`、`buttons`、`detail`、`pointerType`、`width`、`height`、`isPrimary` 都相同。DrissionPage 的 `pressure` 也是 0。【推断】Playwright 按下时给 `Input.dispatchMouseEvent` 带了 `force: 0.5`；【待验】在实现格里用探针确认。
5. 【实测】隐藏后台标签（开之前 `visibilityState:"hidden"`）上，现有 `--trusted` 先开焦点仿真再发事件，点击送达、没有挂起；结束后页面回到 `hidden`，`hasFocus` 仍为 true（与 `docs/07` §1.1「关闭后 hasFocus 不回落」一致）。现有代码不发 `mouseMoved`，所以「未绘制的隐藏标签上 `mouseMoved` 永不返回」这条本格**没有重跑**，沿用 spike 2 的【实测】，引入轨迹后必须在验收里重测（§7 A7.3）。
6. 【实测，范围外，仅记录】tabcap（`--remote-debugging-pipe`、不带 `--enable-automation`）与 Playwright 的探针页上 `navigator.webdriver` 都是 `true`，DrissionPage（`--remote-debugging-port`）为 `false`。`docs/07` §1.2 写的「不传 `--enable-automation`，`navigator.webdriver` 保持 false」与本次实测不符。【推断】原因是 pipe 方式本身。（0.7.6-A 起启动 CfT 默认隐藏 `navigator.webdriver`，见 `docs/04` §40。）

### 2.3 打字【实测】

文本 `"aB3 中"`，从字段获得焦点之后开始计数。

| 运行 | 事件形状 | isTrusted | 节奏 |
|---|---|---|---|
| Playwright `type()`（无头、有头一致；`pressSequentially` 相同） | 每个 ASCII 字符 6 个：`keydown`（`key='a' code='KeyA' keyCode=65 charCode=0`）→ `keypress`（`keyCode=97 charCode=97`）→ `beforeinput`（`insertText`，`data='a'`）→ `textInput` → `input`（`insertText`）→ `keyup`；空格的 `code='Space'`、`keyCode=32`；`'B'` 的 `keyCode=66`；**`'中'` 没有任何按键事件**，只有 `beforeinput` / `textInput` / `input`（`insertText`，`data='中'`）。合计 27 个 | 全部是 | 无头时每个字符约 0.3–0.6 ms（Playwright 默认 `delay:0`）；有头时前两个字符 8–20 ms，属于噪声 |
| Playwright `fill()` | `beforeinput` / `textInput` / `input` 各 1 个，`data` 为整串，没有按键事件 | 是 | — |
| Playwright `press("Enter")` | `keydown` → `keypress` → `beforeinput`（`insertLineBreak`）→ `keyup` | 是 | — |
| tabcap `type`（`Input.insertText`） | `beforeinput` / `textInput` / `input` 各 1 个，`data` 为整串，**没有按键事件**，与 Playwright `fill()` 同形 | 是 | — |
| tabcap `press Enter` | 与 Playwright `press` 同形（字段非空时多一个 `change`） | 是 | — |
| tabcap `fill --trusted` | 与 Playwright `fill()` 同形 | 是 | — |
| tabcap `fill`（默认 DOM） | 只有 `input` 和 `change`，没有 `beforeinput`、没有 `inputType` | **否** | — |

缺口：探针的副本没有记录键盘事件的 `shiftKey` 等修饰键字段（原探针只给鼠标事件记修饰键），所以 Playwright 打 `'B'` 时是否带 Shift【待验】。升格成夹具时要补上（§6）。

## 3. CLI 语义变更（精确版）

### 3.1 `click`

| 项 | 现在 | 提案 |
|---|---|---|
| 默认路径 | 第一级：`el.click()`，`isTrusted:false` | **第二级拟真**：焦点仿真 → 滚入视口 → 遮挡检查 → 轨迹（§3.3）→ `mousePressed` → 随机间隔 → `mouseReleased` → 送达探针 |
| `--trusted` | 第二级、无轨迹 | 保留一版，等同默认，`--help` 写「已是默认，下版删除」（照 `docs/08` §5「旧名保留一版别名」的惯例） |
| DOM 点击 | 默认 | 只能显式 `--dom`；输出 `eventShape:"incomplete"` 和 `warning:"事件序残缺：DOM el.click()，只有 click 事件，isTrusted=false，无 pointer / mouse 序列"` |
| 输出新增字段 | — | `eventShape: "full" \| "incomplete"`；`trajectory: {from:{x,y}, to:{x,y}, points, plannedMs, actualMs}`（只有第二级有；`plannedMs` 在 0.7-C 前叫 `ms`）；`pressGapMs`；第一级、或从第二级降级时有 `warning` 与 `degraded`（原因：`not-painted` / `no-box` / `dom-requested`） |
| 失败 | `not-delivered`、`covered`（0.3-D 遮挡适配器判定被遮挡层挡住）、`page`（终点被遮挡层以外的元素挡住）、`stale-ref` | 不变；新增 `move-timeout`：某条 `mouseMoved` 在单条超时内没有返回，**立即中止，不按下、不重试** |

两种处置（规格第 2 条）的比较：

- **A 删除 DOM 路径**：输出永远是完整事件序，语义最干净。代价是删掉了焦点阶梯的第一级。第一级（`docs/07` §1.1，10-15 作者定）是「不改可见性、不需要坐标」的唯一路径；元素没有盒子（零尺寸、`display:contents`、只在 AX 树里出现）时，`click` 会变成不可用，只能让 agent 改用 `evaluate` 手写 `el.click()`，事件序同样残缺，而且输出里没有任何标记。
- **B 改名 `--dom`、输出标「事件序残缺」**（**建议**）：阶梯三级不变，只把默认档从第一级挪到第二级；残缺路径仍然可用，但必须显式选择，并且结果里写明。符合 `AGENTS.md`「默认最少打扰」之外的另一条原则：结果诚实，不假装可信。

代价（选 B 时）【推断】：默认点击会让页面在命令期间变成 `visible`（第二级的既有代价，作者 10-15 已接受）；每次点击多花约 0.15–0.55 s（轨迹 0.1–0.4 s 加按压 50–140 ms）；轨迹经过的元素会收到 hover，可能触发悬停菜单。最后一条是真人输入本来就有的副作用，但会让原来 DOM 点击能过的 L2 用例改变行为，实现格要逐条复跑既有 e2e。

### 3.2 `type`

| 项 | 现在 | 提案 |
|---|---|---|
| 默认 | 一次 `Input.insertText`（整串） | **逐字符**：在键位表（现有 `parseKey` 的 US 布局）里的字符走 `Input.dispatchKeyEvent`（`keyDown` 带 `text` / `unmodifiedText` → `keyUp`），由 Chrome 合成 keypress / beforeinput / textInput / input；不在键位表里的字符（中文、emoji 等）逐字走 `Input.insertText`。这与 Playwright `type()` 实测一致（§2.3：`'中'` 没有按键事件） |
| 大写和符号 | — | 是否先发 Shift 的 keyDown【待验】（§2.3 的缺口），以夹具补测的结果为准 |
| 节奏 | — | `--delay <ms>`：每两个字符之间的间隔。默认值见 §9 D4。Playwright 默认 0（实测每字符 0.3–0.6 ms） |
| 旧行为 | 默认 | `--insert`：一次 `insertText`，输出 `eventShape:"insert"`、`warning:"事件序残缺：无按键事件（等同粘贴 / fill）"` |
| 输出新增字段 | — | `eventShape: "keys" \| "insert"`、`keys`（发出的按键数）、`inserted`（走 insertText 的字符数） |
| 级别 | 第二级 | 不变。`dispatchKeyEvent` 必须开焦点仿真（`docs/07` §1.1 第一级的说明） |
| 密码字段 | `masked` 打码 | 不变。但逐键发送意味着秘密值被拆成多条 CDP 命令；`raw/cdp.jsonl` 和守护进程日志是否记录**发出**的 `Input.*` 参数【待验】，实现前必须先确认替换在逐字符层面也成立（「凭据不进日志」） |

`press` 不变（与 Playwright 同形，已实测）。`fill` 不在本格范围，但 §2.3 实测它的默认 DOM 路径只有 `input` / `change`、`isTrusted=false`，这里记下，等作者决定是否另开一格。

### 3.3 轨迹（规格第 1 条的落地参数）

- 起点：本标签上一次由 tabcap 发出的指针位置，由守护进程按标签记住；标签新开、导航后，或者没有记录时，起点取 (0,0)【推断：Playwright 鼠标状态的初值也是 0,0，`movementX/Y` 在无头下为 0,0 与此相符；待验】。
- 时长 D 在 [100, 400] ms 内均匀随机。点数 N = max(3, ⌈D × 60 / 1000⌉)，约每帧一点，满足 ≥ 25 点/秒。每点按计划时刻发送，并等待上一条返回，**每条单独设超时**（建议 1 s）。
- 路径：起点到终点的直线加 ease-in-out（minimum-jerk）时间分布；中间点可选加 ±0.4 px 散布（默认关，见 §9 D5）；**最后一点精确等于目标坐标**（散布不作用于终点）。
- 按压：`mousePressed {button:"left", buttons:1, clickCount:1, force:0.5}` → 随机等待 50–140 ms → `mouseReleased {buttons:0, clickCount:1}`。`force:0.5` 用来对齐 §2.2 第 4 条的 `pressure` 差异，【待验】。
- 遮挡检查在**终点**做（沿用现有 `elementFromPoint` 检查）；Part 1 的 overlay 适配器若判定被遮挡，就报 `covered`，**不发任何 move**。
- 随机源：轨迹与间隔由纯函数 `plan(from, to, rng)` 生成，`rng` 可注入；L0 用固定种子做确定性测试。CLI 不暴露种子（§9 D6）。
- 只走 Chrome 输入管线：pointerover / enter / move / down / up 与 mouse 系列全部由 Chrome 合成，**不手写任何 DOM 事件、不 `dispatchEvent`**（规格第 1 条）。

### 3.4 与焦点阶梯整合（规格第 4 条）

1. 开焦点仿真（第二级）。
2. **绘制确认**：在页面里 `Runtime.evaluate` 一个 `requestAnimationFrame` Promise（`awaitPromise`，超时 1 s），同时读 `document.visibilityState`。rAF 按时回调、且 `visible`，才视为「已绘制」，可以发 `mouseMoved`。【推断】rAF 回调说明合成器已为该页出帧，这是「未绘制的隐藏标签」的直接反面；【待验】实现格要在一个从未绘制过的后台标签上验证：开仿真之后 rAF 是否一定按时回调。
3. 未确认绘制时，**绝不发 `mouseMoved`**，按阶梯降级到第一级（`el.click()`），输出 `level:1`、`eventShape:"incomplete"`、`degraded:"not-painted"`，并带「事件序残缺」警告（是否改为直接失败，见 §9 D3）。
4. 第一级（`--dom`，或降级而来）不发轨迹，一律标「事件序残缺」。
5. 第三级（`bringToFront`）仍不在 AI 命令路径上，不变。

## 4. 失败语义与 guard 的交界（规格第 5 条）

- 输入命令**从不自动重试、从不连发**：`move-timeout`、`not-delivered`、被遮挡、`stale-ref` 都只报一次错，`next` 交给 agent 或人决定。现有 `not-delivered` 的 `next` 写的是「Retry once」，建议改成「先 snapshot / screenshot 看页面，由你决定是否再点一次」，不让工具暗示连发。
- 页面层的异常响应（4xx、空正文、挑战页）由录制器与 guard 识别；输入命令本身不判断。具体熔断（计数、冷却、`waiting`）属于 guard 格，本格不实现、不改阈值，只约定交界：输入命令执行前检查会话是否处于 `waiting`（既有行为），执行后不因为页面上的任何响应重放自己。
- 实现约束（作者已经付过学费的通用教训，原文照录）：「给运行时行为打补丁的通用教训（作者已付过学费）：一切包装/拦截必须在实例方法层做——代理/委托层永远接不住内部自调用。」落到本格：轨迹、超时、打码都包在 `Transport.send` 的调用点（`click` / `type` 的实现函数）里，不另外加一层「输入代理」去拦 `send`。【推断】守护进程内部的其它路径（截图、焦点仿真）会直接调 `send`，代理层接不住这些调用。

## 5. `docs/07` §1.1 要加的行（作者审后合并）

建议在「后台标签与焦点阶梯」一节末尾追加：

```
- **拟真点击（0.3-D 提案，docs/10）**：第二级上的默认点击 = 焦点仿真 → rAF 绘制确认（1 s）→ mouseMoved 轨迹（100–400 ms、约 60 点/秒、终点精确、每条单独 1 s 超时）→ mousePressed {clickCount:1, force:0.5} → 50–140 ms → mouseReleased。未确认绘制绝不发 mouseMoved（spike 2：未绘制的隐藏标签上永不返回），降到第一级并标「事件序残缺」。【实测 10-15：Playwright page.click 只有 1 条 mouseMoved、按压间隔 < 1 ms；tabcap --trusted 与 DrissionPage 默认点击 0 条 move】
- **逐键输入（0.3-D 提案）**：type 默认逐字符 Input.dispatchKeyEvent（keyDown 带 text → keyUp），不在键位表里的字符逐字 Input.insertText；必须开焦点仿真。旧的整串 insertText 只在 --insert 下用，标「事件序残缺」。【实测 10-15：Playwright type() 每个 ASCII 字符 6 个事件全部可信，'中' 只有 beforeinput / textInput / input】
- **第一级的定位**：`el.click()` 只在 `--dom` 或降级时使用，输出必带 eventShape:"incomplete"。
```

启动参数表（§1.2）不需要新增参数【推断】：轨迹与按键都是运行时 CDP 调用。

## 6. `docs/05` 要加的场景（作者审后合并）

编号：`docs/09` §12 已经提案到 s45，这里暂用 **s46**，最终编号由作者定。

```
### s46 input-fidelity（P1；拟真点击与逐键输入）
- 页面：fixtures/probe/input-probe.html，由 /tmp/tabcap-probe/probe.html 升格。捕获阶段记录 pointer / mouse / keyboard / beforeinput / textInput / input / composition / focus 的全部字段（键盘事件补 shiftKey / ctrlKey / altKey / metaKey）；一个 260×90 的 #target 和一个 #field；上报地址改为页面同源的 /report，由 e2e 站点接收，不再写死端口。只记录、不改变任何行为。
- oracle：fixtures/probe/oracle/ 下的 Playwright 导出（无头、CfT 固定版本、Playwright 版本写进文件名），由 scripts/probe-oracle（不进默认测试，Playwright 不成为依赖）在本机对该页生成，人工检查后提交；DrissionPage 导出只作对照。另有一份作者手点、手打的导出（L3，作为「真人下限」的节奏 oracle）。
- 证明：tabcap 默认 click 的事件结构与 Playwright 导出同形，且 pointerdown 前有轨迹；--dom 与降级路径被标「事件序残缺」；隐藏标签走阶梯、不挂起；type 的逐键结构与 Playwright type() 导出同形。
- expected（全部从 oracle 导出派生，不手写）：
  - click 结构：去掉连续重复的 (pointermove, mousemove) 对之后，序列等于 Playwright 无头导出 `pointerover > mouseover > pointermove > mousemove > pointerdown > mousedown > pointerup > mouseup > click`；全部 isTrusted；click.detail = 1；pointerdown 的 button / buttons / pointerType / pressure 等于导出值（0 / 1 / mouse / 0.5）。
  - 轨迹：pointerdown 前 pointermove ≥ 1 条，最后一条与 pointerdown 坐标差 ≤ 1 px；move 条数、时长、按压间隔在 §3.3 的范围内（范围本身待作者按 L3 真人导出确认）。
  - type "aB3 中"：每个 ASCII 字符的 (type, key, code, keyCode, charCode, inputType, data, isTrusted) 序列等于 Playwright type() 导出；'中' 只有 beforeinput / textInput / input。
  - --dom：只有 1 个 click，isTrusted=false，输出 eventShape:"incomplete"。
```

## 7. `docs/06` 要加的验收（先写测试，再实现）

新增 **A7「输入保真」**（编号由作者定）：

| 测试 | 层 | 做法 | 通过 |
|---|---|---|---|
| A7.1 拟真点击形状 | L2 | s46 页面，`tabcap click <ref>`（默认），读页面导出 | pointerdown 前 ≥ 1 条 move，终点坐标差 ≤ 1 px；到 click 为止全部 isTrusted；结构序列（折叠重复 move 对后）等于 Playwright 导出 |
| A7.2 轨迹参数 | L0 | 纯函数 `plan(from, to, rng)` 用固定种子跑 1000 次 | 点率 ≥ 25/s；时长 ∈ [100, 400] ms；终点精确；散布开时中间点偏离直线 ≤ 0.4 px；按压间隔 ∈ [50, 140] ms |
| A7.3 隐藏标签不挂起 | L2 | `navigate --new-tab` 开后台标签（`visibilityState:"hidden"`）后立即默认 click；另用假 CDP 让 rAF 永不回调 | 真实标签：命令在超时内返回，送达或标 `degraded:"not-painted"`，不挂起；假 CDP：一条 `mouseMoved` 都没发（调用记录断言） |
| A7.4 第一级标记 | L2 | `click --dom`；以及 A7.3 的降级 | `level:1`、`eventShape:"incomplete"`、警告含「事件序残缺」；页面导出只有 1 个不可信 click |
| A7.5 逐键输入 | L2 | `click` 字段 → `type "aB3 中"` | 逐字段等于 Playwright type() 导出（§6 列出的字段）；`--insert` 的形状等于 Playwright fill() 导出，并标「事件序残缺」 |
| A7.6 逐字段 diff 报告 | L2 | 测试把 tabcap 与 Playwright 导出逐事件、逐字段比对，写进测试输出 | 结构字段零差异；节奏字段（timeStamp、move 条数、间隔）只列出、不断言相等；`screenX/Y` 剔除 |
| A7.7 不重试 | L0 | 假 CDP：`mouseMoved` 超时、探针未送达 | 各只发一次，报 `move-timeout` / `not-delivered`，不按下、不再发 |
| A7.8 不回退 | L0 + L2 | 全量 `bun test` 与 `bun run test:e2e` | 全绿；既有用例里依赖 DOM 点击的改成显式 `--dom`，每一处在 NOTES 写明理由 |
| A7.9 真人节奏 oracle | L3 | 作者在 s46 页面手点 10 次、手打一次 `aB3 中`，导出提交为 `fixtures/probe/oracle/human-*.json` | 作者确认；§3.3 的时长、点率、按压间隔范围按它复核【人确认】 |
| A7.10 秘密值不进日志 | L2 | s07 式登录，用 `type` 逐键打密码 | `raw/cdp.jsonl`、守护进程日志、CLI 输出 grep 不到密码明文，也 grep 不到按位置拼回的明文 |

## 8. 交付顺序与范围

1. 作者审本提案（§9 逐条定）。
2. 实现前：`docs/05` 加 s46、`docs/06` 加 A7、`docs/07` §1.1 加行（作者合并）；`probe.html` 升格为 `fixtures/probe/input-probe.html`；生成并提交 Playwright 导出与作者的真人导出。
3. 实现：`click` / `type` / 轨迹纯函数 / 绘制确认 / 输出标记；先写 A7 测试。
4. 对拍报告：A7.6 的逐字段 diff 进报告。
5. NOTES 三行收尾。

不在本格做：guard、回放、HAR 的任何语义；`fill` 的路径；任何指纹相关的改动；任何第三方站点上的测试。

## 9. 待作者定

- **D1** DOM 路径：A 删除，还是 B 改名 `--dom` 并标「事件序残缺」。建议 B（§3.1）。
- **D2** `--trusted` 的去留：保留一版作为无操作的别名（建议），还是立即删除。
- **D3** 隐藏标签确认不了绘制时：自动降到第一级并打标记（建议，照验收原文「按阶梯降级」），还是直接失败（`not-painted`），由 agent 显式改用 `--dom`。
- **D4** `type --delay` 的默认值：0（与 Playwright 一致），还是按 A7.9 的真人导出取一个下限（例如中位数）。在真人 oracle 到位之前，任何具体数值都只是推理，不能当 expected。
- **D5** ±0.4 px 散布默认开还是关（建议关；只作用于中间点）。
- **D6** 是否给 CLI 暴露随机种子（建议不暴露；L0 用注入的 rng）。
- **D7** 规格的「与 Playwright 同形」，按 §2.2 的实测解释为**结构同形**（事件种类、顺序、可信性、按钮字段），节奏字段以真人 oracle 为准。请作者确认这一读法。

## 10. 歧义清单（按最字面的读法处理，请裁决）

1. 规格第 1 条的轨迹参数与 Playwright 实测（单个 move、按压间隔 < 1 ms）不一致；本文按「结构对齐 Playwright，节奏按规格」处理（D7）。
2. 「终点坐标差 ≤ 1 px」比较的是哪两个点：本文取最后一个 `pointermove` 与 `pointerdown` 的 `clientX/Y`（`pointerdown` 本身由 `mousePressed` 的坐标决定）。
3. 「事件序残缺」写在哪里：本文放在 JSON 的 `warning` 字段，另加机器可读的 `eventShape:"incomplete"`；CLI 不另外打印到 stderr。
4. NOTES 原探针用的是品牌版 Chrome，本次重跑用 CfT 155.0.8059.79；结构结论一致，具体坐标与 movement 数值不同（见 §2.2 观察 2）。
5. 规格第 3 条「对照现状 insertText 的差异再定规格」：§3.2 是在差异实测之后给出的规格草案；修饰键（Shift）一项仍是【待验】，要等夹具补齐字段后才能定。

## 作者决定（10-15）

- D1 / D2：默认仍是 JS 点击（`el.click()`），输出照提案标 `eventShape:"incomplete"`；`--trusted` 保留，作为打开整套可信输入配置的开关（移动轨迹、按下抬起间隔、逐键打字），不改默认。
- D3：隐藏标签确认不了已绘制时自动降级到 JS 点击并打标记，不挂起。
- D4：`type --delay` 默认 0；真人节奏的 oracle 到位后再定下限。
- D5：±0.4 px 散布默认关。
- D6：不暴露随机种子，测试用注入的 rng。
- D7：不要求与 Playwright 严格同形；目标是让 `--trusted` 路径的输入尽可能可信、与真人无异，具体形状以本地探针 oracle 为准。
- 附带：页面不读取的响应体，`responseReceived` 后 1 s 仍无完成事件且 Fetch 已取得全文时按 `finished` 写入并标 `unreadByPage:true`（docs/04 §19 提案，作者已定）。
- 提案中给 docs/05（s46）、docs/06（A7.1–A7.10）、docs/07 §1.1 的条目，实现时按上述决定修订后并入对应文档，标「作者定 10-15」。

## 0.7.3 外部评测补充（分支 `0.7.3-review-fixes`，10-18）

- **`--trusted` 点到会导航的目标**：探针回读失败不再一律按 `cdp` / `not-delivered` 失败。按下后如果标签的导航记录变了（`Page.frameNavigated` / 同文档导航的 epoch，或 URL 变化），这次点击算已送达：`delivered:{pointerdown:"unknown",mousedown:"unknown",reason:"navigated"}`、`eventShape:"full"`，随后照普通导航路径等就绪并给 `effect:"navigation"` 与 `url`；没有导航记录才报 `not-delivered`。双击同此。等待上限 2 s，只在回读失败后发生。
- **无 role 的全屏 mask 包住对话框**（`src/daemon/adapters/overlay/page.js`）：固定层覆盖 ≥ 90% 视口、内部有一个可见块（容器而非控件本身，至少 160 × 60 px）面积 ≤ 60% 视口、该块有不透明背景（alpha ≥ 0.5）或有可见边框 / 阴影、且含按钮或表单控件 → 当作 `dialog`；evidence 加 `"full-viewport wrapper"` 与 `"buttons in an inner block"`。层自身文字 > 500 字不按此判，避免把铺满视口的应用根容器当遮挡层；普通固定页头 / 底栏面积小，不是候选。普通 `click` 的 `overlayCheck` 在分类器之后还在目标中心做一次 `elementFromPoint`：命中的不是目标 / 其后代 / 其可点击祖先容器就报 `covered`（`next` 保留「先关遮罩」的建议），与 `--trusted` 的判定一致。
