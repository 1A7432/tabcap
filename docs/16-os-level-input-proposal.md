# OS 级输入：`--os`（提案，待审）

2026-11-13。作者同日定「做」；本文是设计，未审，未写代码。标注同 `04`：【实测】【推断】【待验】【人确认】。

## 0. 一屏要点

- **为什么**：银行安全控件这类输入框不认 CDP 输入。11-13 的使用反馈【人确认：反馈原文】：`tabcap type`（`Input.insertText`）后控件的长度一直是 0；改用 Win32 `keybd_event` + `VkKeyScanW`、每键 150 ms 后可以。原因【推断】：CDP 的 `Input.*` 从 Chrome 内部的输入管线注入，不经过操作系统的键盘队列，而这类控件在操作系统一层读键。
- **做什么**：在现有三条输入命令上加第三档 `--os`，由守护进程调用操作系统的输入接口。不加新命令。
- **代价**：`--os` 必须让 Chrome 窗口成为系统前台，并占用真实的键盘和鼠标。这与 tabcap「后台操作、不抢前台」的默认相反，所以只能是显式的一档，输出里标明。
- **先做 Windows**（真实需求在那里）；macOS 第二步；Linux 进 backlog。
- **验不了的**：真实控件认不认，靶场模拟不了，只能在 Windows 那台机器上由人确认。

## 1. 输入的三档

| 档 | 怎么发 | 页面里 `isTrusted` | 经过 OS 键盘 / 鼠标队列 | 要前台 |
|---|---|---|---|---|
| 默认 | DOM（`el.click()`、设值）或 `Input.insertText` | 部分 | 否 | 否 |
| `--trusted` | CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent`（焦点模拟） | 是 | 否 | 否 |
| `--os`（新） | 操作系统接口：Windows `SendInput`，macOS `CGEventPost` | 是 | **是** | **是** |

## 2. CLI

```
tabcap click <ref> --os                 # 元素中心；先滚进视口
tabcap click --os --at 1535,397         # 视口内的 CSS 像素坐标；窗口偏移与缩放由 tabcap 处理
tabcap type <text> --os [--delay ms]    # 逐键，默认每键间隔 120 ms（见 §9 待定 3）
tabcap type --os --secret site.field    # 密码只能这样给
tabcap press-key Enter --os
```

- `--os` 与 `--trusted` 不同用。`fill`、`hover`、`select` 第一版不加 `--os`。
- 密码不进命令行参数（AGENTS.md 凭据规则）：`type` 新增 `--secret <site.field>`，只在 `--os` 下可用，值由守护进程从本地库取；输出与证据包里是 `<secret:…>`。同一站点同一会话一次密码输入的限制（`guard.login-limit`）照 `fill --secret` 计。反馈里建议的 `keys --os "<密码>"` 不做。
- 回答新增：`input: "os"`、`foreground: {taken: true, restored: bool}`、`eventShape: "os"`；`type` 另有 `keys`（发出的按键数）与 `layout`（按哪个键盘布局换算的）。

## 3. 每次 `--os` 命令做什么

1. **拿前台**：把标签带到前面（焦点阶梯第三级，`Page.bringToFront`），再用操作系统接口确认前台窗口属于 tabcap 启动的那个 Chrome 进程。确认不了 → 新错误 `not-foreground`，不发任何输入；`next` 请人点一下浏览器窗口再重试。
2. **点击**：先把系统指针移到目标点，由页面里的监听（tabcap 自己的隔离世界，同接管监听）读回这次 `mousemove` 的 `clientX` / `clientY`。与目标差 2 px 以内才按下；有偏差就按差值修正一次；修正后仍不对 → `not-delivered`，不按。这样不依赖对窗口边框、信息栏、缩放比例、多显示器的任何假设。
3. **打字**：每个键之前重新确认前台窗口；焦点一变（人切走了、弹了别的窗口）立刻停，回 `not-foreground` 并写明已发出几个键。绝不把后面的键打进别的程序。
4. **不触发接管**：`--os` 发出的输入在页面里和真人的一样是 trusted。命令期间与之后 500 ms 记为 tabcap 自己的输入窗口（沿用 `Input.*` 的那套 `InputWindows`），接管监听不把它算成人。
5. **收尾**：按 `chrome.restoreFront` 的现有规则把前台还给原来的程序（只在 tabcap 自己抢了前台时）。
6. **证据包**：`action` 事件 `{op, input: "os", …}`；打字不记键值（密码），只记个数与间隔。`raw/cdp.jsonl` 里这条命令的窗口内没有 `Input.*`。

## 4. 键怎么换算（Windows）

- 默认按**扫描码**发（`KEYEVENTF_SCANCODE`）：这是读硬件键的控件认的形式。字符 → 虚拟键 + Shift 用 `VkKeyScanExW`，按前台窗口线程当前的键盘布局（`GetKeyboardLayout`）换算，再 `MapVirtualKeyExW` 得扫描码。这个布局打不出的字符 → `usage` 错误，列出是哪个字符，不发任何键。
- CapsLock 开着时先报错（`next` 让人关掉），不代按。
- 输入法：密码类控件通常自己关掉输入法【推断】。输入法开着时字母键会进候选框，tabcap 发之前无法可靠地跨进程读到这个状态【待验】；第一版在回答里写 `layout`，文档写明先把输入法切到英文。
- 另给 `--os-text`：用 `KEYEVENTF_UNICODE` 发字符本身，不看布局和输入法，适合普通输入框里的中文；读扫描码的控件不认它，所以不是默认。
- 不做：驱动级注入；隐藏或伪造「注入」标志（`LLKHF_INJECTED`）。读内核键盘驱动的控件连 `SendInput` 也不认，这类不在范围内。

## 5. 实现

- 不加原生组件：守护进程里用 `bun:ffi` 直接调 `user32.dll`（`SendInput`、`GetForegroundWindow`、`GetWindowThreadProcessId`、`GetKeyboardLayout`、`VkKeyScanExW`、`MapVirtualKeyExW`、`GetKeyState`）。
  - 【实测】`bun:ffi` 在 `bun build --compile` 的单文件里能调系统库（macOS arm64，Bun 1.4.4：`getpid`、`AXIsProcessTrusted`、`CGMainDisplayID` 三个只读调用，编译前后结果一致）。带 `bun:ffi` 的代码能交叉编译出 `bun-windows-x64` 的 exe【实测：编译成功；没有 Windows，没运行】。
  - 【待验】Windows 上 `dlopen("user32.dll")` 与 `SendInput` 的结构体传参。`INPUT` 在 x64 上 40 字节（`type` 4 + 对齐 4 + 联合体 32），偏移以 Windows SDK `winuser.h` 为 oracle，单测按字节比对。
- 平台不支持时（Linux、Wayland、没装依赖）`--os` 回 `unsupported`，不退回 `--trusted`（退回会让人以为发的是 OS 输入）。
- macOS（第二步）：`CGEventPost` 需要给 tabcap 授「辅助功能」权限，这一步要作者在系统设置里点【人确认时再做】；没授权时回 `unsupported` 并写明去哪授。

## 6. 靶场与验证

- 靶场场景 s82（拟）：一页，页面把收到的 `keydown` / `keyup` / `mousedown` / `click` 的 `isTrusted`、`code`、`key`、坐标记进 `window.__s82`。
- **oracle**：`__s82` 里有与输入相符的 trusted 事件，**同时** `raw/cdp.jsonl` 在这条命令的窗口内没有任何 `Input.*` 命令 → 事件只能来自操作系统。
- 走法：`click <ref> --os` 命中目标；`type abcXYZ19 --os` 的 `code` 序列与大小写（Shift）正确；`--secret` 时输出与证据包里没有明文；命令中途把前台切走 → `not-foreground`，`__s82` 里的键数等于回答里的 `keys`；`--os` 期间不进 `human-takeover`。
- 单测（离线）：字符 → 按键计划（布局表做 fixture）、`INPUT` 字节、前台判定与中止逻辑（假的系统接口）。
- 在哪跑：只能在 Windows 上。CI 的 `windows-latest` 已经跑 e2e；runner 有没有可交互桌面、`SendInput` 与抢前台在上面行不行【待验】，先加一个探针步骤量一下，不行就标成「需作者 / Windows 机器手动」。
- 真实控件：`--os` 在那个银行控件上是否有效、要多大的键间隔【人确认，Windows 机器上】。本仓库的 AI 不对靶场以外的站点操作。

## 7. 风险

- **抢前台、占键鼠**：`--os` 期间人不能同时用键盘鼠标，否则两边的键会混在一起。命令尽量短；每键前查前台是唯一的防线，防不了人在同一个窗口里同时打字。
- **Windows 的前台锁**：后台进程调 `SetForegroundWindow` 可能只闪任务栏不切换【推断：Win32 文档】。所以第 1 步先试 `Page.bringToFront`，确认不了就请人点一下，不绕过。
- **坐标**：闭环校验（§3 第 2 步）失败时不点，不会点错地方；代价是在读不回 `mousemove` 的地方（跨进程 iframe、原生子窗口）第一版点不了【待验】。
- **误用**：密码打进别的窗口。靠每键前的前台检查和「密码只走 `--secret`」两条。

## 8. 交付顺序

1. CI 探针：Windows runner 上 `SendInput` 与前台能不能用（半格）。
2. Windows：`type --os` / `press-key --os`（含 `--secret`、前台检查、中止），s82 的键盘部分。
3. Windows：`click --os`（闭环坐标），s82 的鼠标部分。
4. 作者在 Windows 机器上对真实控件确认；按结果定默认键间隔。
5. macOS（要授权）。Linux backlog。

## 9. 待作者定

1. 形状：现有命令加 `--os` 档（本文），还是反馈建议的新命令 `keys`？
2. 范围：第一版只做 Windows，同意吗？
3. `type --os` 的默认键间隔：反馈里 150 ms 可用。我的建议 120 ms，可用 `--delay` 改；真人确认后再定。
4. `--os-text`（Unicode 直发）第一版要不要？不做的话普通输入框里的中文仍用 `--trusted`。
5. 抢前台后是否自动还回去（沿用 `chrome.restoreFront`，默认还）。
6. 新错误码 `not-foreground`、`type --secret`、回答字段的命名。
7. `handoff` 相关不改：`--ignore-synthetic-input` 与超时自动恢复不做（`04` §54.4）。有了 `--os`，自己写脚本注入按键从而触发接管的主要原因就没了。
