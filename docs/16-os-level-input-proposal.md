# OS 级输入：`--os`

2026-11-13。作者同日审过提案并同意（§9 七条按提案定）；Windows 部分已实现（分支 `1.1-c-os-input`），下文按实现修订。标注同 `04`：【实测】【推断】【待验】【人确认】。本机是 macOS，**Windows 上的行为在 CI 的 Windows runner 跑过之前都是【待验】**；真实控件只能由作者在那台 Windows 上确认。

## 0. 一屏要点

- **为什么**：银行安全控件这类输入框不认 CDP 输入。11-13 的使用反馈【人确认：反馈原文】：`tabcap type`（`Input.insertText`）后控件的长度一直是 0；改用 Win32 `keybd_event` + `VkKeyScanW`、每键 150 ms 后可以。原因【推断】：CDP 的 `Input.*` 从 Chrome 内部的输入管线注入，不经过操作系统的键盘队列，而这类控件在操作系统一层读键。
- **做了什么**：在 `click` / `type` / `press-key` 上加第三档 `--os`，由守护进程调用操作系统的输入接口。没有新命令。
- **代价**：`--os` 必须让 Chrome 窗口成为系统前台，并占用真实的键盘和鼠标。这与 tabcap「后台操作、不抢前台」的默认相反，所以只是显式的一档，回答里标明（`input: "os"`、`foreground`）。
- **只有 Windows**（真实需求在那里）；别的系统回 `unsupported`，不退回 `--trusted`。macOS 是下一步（要作者授「辅助功能」权限）；Linux 进 backlog。
- **验不了的**：真实控件认不认，靶场模拟不了，只能在 Windows 那台机器上由人确认。

## 1. 输入的三档

| 档 | 怎么发 | 页面里 `isTrusted` | 经过 OS 键盘 / 鼠标队列 | 要前台 |
|---|---|---|---|---|
| 默认 | DOM（`el.click()`、设值）或 `Input.insertText` | 部分 | 否 | 否 |
| `--trusted` | CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent`（焦点模拟） | 是 | 否 | 否 |
| `--os` | 操作系统接口：Windows `SendInput` | 是 | **是** | **是** |

## 2. CLI

```
tabcap click <ref> --os                 # 元素中心；先滚进视口；frame 里的 ref 也行
tabcap click --os --at 330,170          # 视口内的 CSS 像素坐标（只限根文档；点在 iframe 里要用 ref）
tabcap type <text> --os [--delay ms]    # 按扫描码逐键，默认每两个字符间隔 120 ms
tabcap type <text> --os-text            # 发字符本身（KEYEVENTF_UNICODE），不看键盘布局和输入法
tabcap type --os --secret site.field    # 密码只能这样给；--confirm 同 fill
tabcap press-key Enter --os             # 也可 Control+a、Shift+Tab；Meta 不发
```

- `--os` 与 `--trusted` / `--insert` 不同用；`click --os` 不支持 `--dbl-click`；`--at` 只在 `--os` 下可用，与 ref 二选一。`fill`、`hover`、`select` 没有 `--os`。
- `click` 的 `<ref>`、`type` 的 `<text>` 因此变成可省（分别由 `--at`、`--secret` 顶替）；两样都没给仍是 CLI 一侧的 `usage` 错误（退出码 2）。
- 密码不进命令行参数（AGENTS.md 凭据规则）：`type --secret <site.field>` 只在 `--os` / `--os-text` 下可用，值由守护进程从本地库取，回答与证据包里是 `<secret:…>`。同一站点同一会话一次密码输入的限制（`guard.login-limit`）与 `fill --secret` 共用一个计数。反馈里建议的 `keys --os "<密码>"` 不做。
- 回答（三条命令共有）：`input: "os"`、`level: 3`、`trusted: true`、`eventShape: "os"`、`foreground: {taken, restored}`。
  - `type` 另有 `keyMode`（`scan` / `unicode`）、`keys`（发出的按键数，不含 Shift）、`delayMs`、`layout`（键盘布局的语言 id，4 位小写十六进制，`0409` 是美式英文）、`length`、`masked`，`--secret` 时有 `secret` 与 `value: "<secret:…>"`。
  - `click` 另有 `at`（视口坐标）、`pointer: {moves, corrections}`、`pressGapMs`、`delivered`、`landedOn`，ref 形式还有 `overlayCheck` 等与普通 click 相同的字段。
  - `press-key` 另有 `key`、`layout`。
- `tabcap browser status` 新增 `inputs: {cdp, os}`：守护进程发出的 CDP `Input.*` 命令数与操作系统收下的输入记录数（审计用，见 §6）。

## 3. 每次 `--os` 命令做什么

1. **先过原有的关**（click：ref 解析、可见、覆盖层、落点；type：密码库与登录次数）。这些不过，不碰前台。
2. **拿前台**：前台窗口已经是 tabcap 的 Chrome 且这个标签有焦点 → 不动（`taken: false`）。否则 `Page.bringToFront`（焦点阶梯第三级），再查，最多等 3 s；仍不是 → `not-foreground`，不发任何输入，`next` 请人点一下浏览器窗口的标题栏再重试（点在页面里会被算成人接管）。**不用任何绕过前台锁的手法。**
   - 「是不是」的判定：操作系统说前台窗口属于 tabcap 启动的那个 Chrome 进程（`GetForegroundWindow` + `GetWindowThreadProcessId`），**并且**页面自己说 `document.hasFocus()` 且可见。后一条排除了「Chrome 在前但焦点在别的标签、地址栏或浏览器弹出的气泡上」。这句话在 tabcap 自己的隔离世界里问（页面脚本改不了答案），问之前先把焦点模拟关掉（上一条 `--trusted` 没关成的话，每个标签都会说自己有焦点）。
   - 还要**没有人按着键**：真实键盘上的 Shift / Control / Alt / Windows 键或鼠标键按着时不发（`SendInput` 不清键盘状态，人按着 Control 时 tabcap 的 `w` 就成了关标签）。读到按着会隔 40 ms 再读一次（可能是 tabcap 自己的 Shift 刚抬起）；仍按着 → `not-foreground`，`error.reason: "held"`，`next` 请人松手，不去抢前台。
   - **全守护进程同一时刻只有一条 `--os` 命令**（键盘和鼠标只有一套，不分标签和会话）；后一条等前一条真正结束才开始。
3. **点击（闭环）**：在目标所在的那个文档（frame 的 ref 就是 frame 自己的文档）装一个只读监听，记下 trusted 的 `mousemove` 位置；监听装在隔离世界里，页面脚本看不见也喂不了假数据。先按窗口位置估一个屏幕点，在它旁边（朝文档中间偏 16 个屏幕像素）和它上面各移一次指针，由两次读回量出「屏幕上多少单位是 1 个 CSS 像素」；再按差值修正，至多 3 次。页面读回的位置与目标差 2 px 以内、且那一点 `elementFromPoint` 确实落在目标上，才按下（系统里左右键互换时按的是物理右键，即主键）；否则 `not-delivered`，不按。这样不依赖对窗口边框、信息栏、缩放比例、多显示器、进程是否 DPI 感知的任何假设。按下后读页面的 `pointerdown` / `mousedown` 记录；没到 → `not-delivered`；页面被这次点击带走（有导航记录）→ `delivered.reason: "navigated"`，同 `click --trusted`。
4. **打字**：整段先换算成按键计划并检查（有打不出的字符、Caps Lock 开着、打完要超过命令时限 → 一个键都不发）。然后逐键发；**每个键之前**重做第 2 步的判定，前台一变立刻停，回 `not-foreground`，`keys` / `of` 写明已发出几个。按下的键一定抬起，Shift 一定放开。绝不把后面的键打进别的程序。
5. **不触发接管**：`--os` 发出的输入在页面里和真人的一样是 trusted。整条命令期间与结束后 500 ms 记为 tabcap 自己的输入窗口（沿用 `Input.*` 的 `InputWindows`），接管监听不把它算成人。
6. **收尾**：这条命令抢过前台、`chrome.restoreFront` 没关、原来的前台窗口不是 Chrome、而且 Chrome 此刻仍在前台（人中途切走的不动）→ 把前台还给原来的窗口，`foreground.restored` 说成没成。等页面动作后的等待结束了才还。
7. **命令超时或被对话框打断**：命令一结束，循环在下一次系统调用前停下，不会在命令返回之后继续打字。
8. **证据包**：`cmd` 事件的 `input` 里有 `os: true`（`--secret` 时是引用，不是值）；`type` 的文本同以前一样推迟到结束事件、密码框里的打码。

## 4. 键怎么换算（Windows）

- 默认按**扫描码**发（`KEYEVENTF_SCANCODE`）。字符 → 虚拟键 + 是否要 Shift 用 `VkKeyScanExW`，按前台窗口线程当前的键盘布局（`GetKeyboardLayout`）换算，再用 `MapVirtualKeyExW` 得扫描码。换行是 Enter（`\r\n` 算一个），Tab 是 Tab 键。
- 这个布局打不出的字符、要 AltGr 的字符、死键（`'a` 会变成 `á` 的那种）→ `usage` 错误，说第几个字符（不是密码时带码位），不发任何键。死键只认得出不带 Shift 就是死键的那些（`MapVirtualKeyExW` 的 `MAPVK_VK_TO_CHAR`）；Shift 之后才是死键的（美式国际布局的 `^`、`"`）认不出【已知缺口】。
- Caps Lock 开着 → `unsupported`，`next` 让人关掉；tabcap 不代按。读的是 `GetKeyState`，守护进程没有消息循环，这个读数会不会过时【待验】。
- 输入法：tabcap 发之前读不到输入法是否开着【待验：有没有可靠的跨进程读法】。回答里的 `layout` 是布局，不是输入法状态；文档写明先把输入法切到英文。
- `--os-text`：用 `KEYEVENTF_UNICODE` 发字符本身（每个 UTF-16 码元一对按下 / 抬起），不看布局和输入法，适合普通输入框里的中文；读扫描码的控件不认它，所以不是默认。
- `press-key --os`：具名键按虚拟键查扫描码（方向键、Home / End、PageUp / PageDown、Delete 带扩展键标志）；单个字符在没有 Control / Alt 时按「打出这个字符的键」算（`A`、`?` 自带 Shift）；Meta（Windows 键）不发，`usage`。
- 不做：驱动级注入；隐藏或伪造「注入」标志（`LLKHF_INJECTED`）。读内核键盘驱动的控件连 `SendInput` 也不认，这类不在范围内。

## 5. 实现

- 不加原生组件：守护进程里用 `bun:ffi` 直接调 `user32.dll`（`SendInput`、`GetForegroundWindow`、`GetWindowThreadProcessId`、`GetKeyboardLayout`、`VkKeyScanExW`、`MapVirtualKeyExW`、`GetKeyState`、`GetSystemMetrics`、`SetForegroundWindow`）。
  - 代码：`src/daemon/os/input.ts`（接口、`INPUT` 记录的字节、按键计划，纯函数）、`src/daemon/os/win32.ts`（FFI 绑定）、`src/daemon/tools/osinput.ts`（前台、逐键、指针闭环）、`src/daemon/tools/input.ts`（三条命令的接线）。
  - 【实测】`bun:ffi` 在 `bun build --compile` 的单文件里能调系统库（macOS arm64，Bun 1.4.4：`getpid`、`AXIsProcessTrusted`、`CGMainDisplayID`，编译前后结果一致）；带 `bun:ffi` 的代码能交叉编译出 `bun-windows-x64` 的 exe【实测：编译成功；没在 Windows 上运行】。
  - `INPUT` 记录在 64 位上 40 字节：`type` 在 0，联合体在 8（`ki.wVk` 8、`ki.wScan` 10、`ki.dwFlags` 12；`mi.dx` 8、`mi.dy` 12、`mi.dwFlags` 20）。oracle 是 `winuser.h` 的结构体定义；单测按字节比对手写的期望值。【待验】在 Windows 上 `dlopen("user32.dll")` 与这些调用实际可用。
- 平台不支持时 `--os` 回 `unsupported`（带 `platform`），不退回 `--trusted`（退回会让人以为发的是 OS 输入）。
- macOS（下一步）：`CGEventPost` 需要给 tabcap 授「辅助功能」权限，这一步要作者在系统设置里点【人确认时再做】。

## 6. 靶场与验证

- 靶场场景 s82（`05`；`test/e2e/site.ts` 的 `startOsSite`，`test/e2e/v12c.e2e.test.ts`）：一页，把收到的每个键盘 / 指针事件连同 `isTrusted`、落在哪个元素、坐标记进 `window.__s82`；有文本框、密码框、按钮、一个固定位置的色块（`--at`）、一个同源 iframe 里的按钮（frame ref）。
- **oracle**：`__s82` 里有与输入相符的 trusted 事件，**同时** `browser status` 的 `inputs.cdp` 在这条命令前后不变、`inputs.os` 增加 → 事件只能来自操作系统。
  - 提案里写的是「`raw/cdp.jsonl` 在命令窗口内没有 `Input.*`」。这条不成立：`raw/cdp.jsonl` 只记 CDP 事件，不记发出的命令【实测：读 `capture/recorder.ts`】。所以改用传输层唯一出口上的计数。
- Windows 上的走法（9 步里的 7 步）：`click <ref> --os` 命中并拿到焦点；`type abcXYZ19 --os` 的 `code` 序列、Shift、记录数（22）正确；`press-key Tab --os` 移焦点；`type --os --secret` 后密码框的值就是库里的值、输出与证据包没有明文、第二次要 `--confirm`；布局打不出的字符整段拒绝；`--os-text` 打中文；`click --os --at` 落在色块上、偏差 ≤ 2 px，点在 iframe 里或视口外被拒；frame ref 与按钮各收到一次 trusted `click`；全程不进 `human-takeover`。
- 所有平台都跑的两步：互斥的参数是 `usage`；非 Windows 上六种 `--os` 命令都回 `unsupported`，页面和两个计数都不动，被拒的 `--secret` 不占登录次数。【实测：本机 macOS，CfT 157】
- 单测（离线，`test/unit/osinput.test.ts`，35 条）：`INPUT` 字节、屏幕坐标换算、按键计划、逐键发送与各种中止（前台丢失、系统拒收、命令结束）、Shift 一定放开、拿前台 / 还前台的各分支、指针闭环（估偏 40 px、第一个估计落空、读回永远对不上、无法标定）、`press-key` 的换算。
- 【待验】CI 的 `windows-latest`：runner 上 Chrome 能不能成为前台、`SendInput` 能不能用。不行的话这 7 步在 CI 上要标成「需 Windows 机器手动」。
- 【待验，测不了】命令中途把前台切走 → `not-foreground`：端到端里没法可靠地造出来，只有单测。
- 真实控件：`--os` 在那个银行控件上是否有效、要多大的键间隔【人确认，Windows 机器上】。本仓库的 AI 不对靶场以外的站点操作。

## 7. 风险

- **抢前台、占键鼠**：`--os` 期间人不能同时用键盘鼠标，否则两边的输入会混在一起。每键前查前台是唯一的防线，防不了人在同一个窗口里同时打字；人同时动鼠标时，点击可能落在别处（按下后的送达检查会报 `not-delivered`，但那一下已经按了）。
- **Windows 的前台锁**：后台进程让窗口成为前台可能只闪任务栏不切换【推断：Win32 文档】。守护进程是后台进程，所以在真实桌面上 `--os` 的第一条命令很可能回 `not-foreground`，要人点一下浏览器窗口的标题栏；之后只要窗口还在前面就不用再点。【待验：实际出现的频率】如果太碍事，可以考虑的正路是由 CLI 进程（从前台终端启动）用 `AllowSetForegroundWindow` 把前台权让给 Chrome，要先在 Windows 上量。
- **还前台会让页面失焦**：命令结束把前台还回去时，页面收到 `blur`。有的控件在失焦时校验甚至清空。`chrome.restoreFront: false` 关掉归还。【待验：那个银行控件怕不怕】
- **坐标**：闭环校验失败时不点，不会点错地方；代价是在读不回 `mousemove` 的地方（`--at` 落在 iframe 里、原生子窗口、页面缩放不是 100 % 时第一估计偏得太远）点不了。
- **误用**：密码打进别的窗口。靠每键前的前台检查和「密码只走 `--secret`」两条。

## 8. 交付顺序

1. ✅ Windows：`type --os` / `--os-text` / `press-key --os`（含 `--secret`、前台检查、中止），`click --os`（闭环坐标），s82，单测。
2. CI 的 Windows runner 跑 s82（开 PR 后才有结果）。
3. 作者在 Windows 机器上对真实控件确认；按结果定默认键间隔、要不要处理前台锁。
4. macOS（要授权）。Linux backlog。

## 9. 作者定过的（11-13「C 同意」，按提案）

1. 形状：现有命令加 `--os` 档，不加 `keys` 命令。
2. 范围：第一版只做 Windows。
3. `type --os` 的默认键间隔 120 ms，`--delay` 可改；真人确认后再定。
4. `--os-text` 第一版就有。
5. 抢前台后自动还回去，沿用 `chrome.restoreFront`（默认还）。
6. 新错误码 `not-foreground`，`type --secret`，回答字段如 §2。
7. `handoff` 不改：`--ignore-synthetic-input` 与超时自动恢复不做（`04` §54.4）。

## 10. 实现与提案不同的地方

- oracle 从 `raw/cdp.jsonl` 改成 `browser status` 的 `inputs`（§6），因此多了这个回答字段。
- 指针修正从「一次」改成「先两次移动量比例，再至多 3 次」（§3 第 3 步）：只修一次时，比例估错（进程是否 DPI 感知不确定）会留下超过 2 px 的残差。
- `click --os` 能点 frame 里的 ref（监听装在目标自己的文档里）；`--at` 只限根文档。
- 多了三处「一个键都不发」的事前检查：Caps Lock、打完会超过命令时限、要 AltGr 的字符。
- `click <ref>` / `type <text>` 的位置参数变成可省（`schema` 里 `required: false`），`type --delay` 的 `default` 不再写 0（两档默认不同）。
- 实现后请 Opus 子代理独立审了一遍（它也没有 Windows；它对照 Microsoft Learn 核了结构体布局、标志值、`VkKeyScanExW` 的返回值，在 macOS 上实测了 `bun:ffi` 的类型转换）。据此加了：全守护进程一次一条 `--os` 命令；人按着修饰键 / 鼠标键时不发；焦点与指针读回改在隔离世界里做；左右键互换；死键；`--at` 的越界与 frame 检查挪到抢前台之前；`Control++` 这类带标点的组合键；读回与等前台的时限放宽（700 ms → 2 s，1.5 s → 3 s）。
- 没做：`click --os --dbl-click`；IME 状态检测；命令中途切前台的端到端；按下之前核对指针下面的窗口属于 Chrome（指针读回在隔离世界里，已经证明指针在页面上）。
