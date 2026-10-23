# 开放待验清单

2026-10-21 建（全面审查后的整理，作者同日批准）。把散在 `docs/*.md` 里的待验、推断标记，和 `NOTES.md` 最近 25 格「卡在哪」里的线程收到一处，逐条标状态。原处的标记不动；只有 `11` §2 那条「解析路径不用 `unreachable` / `@panic`」用 grep 核实后就地改成了实测。以后关掉一条：原处改标记，这里改状态。

## 1. 怎么抽的

- docs：对 `docs/*.md`（不含本文件）逐行找全角方括号括起的标记，内容含「待验」或以「推断」开头的都算，另加方括号外的「待验」字样；行号以本文件提交时为准（`04` 正文本波还有别的包在改，行号可能挪动，按摘要 grep）。抽到 116 处，其中 16 行共 26 处是标注说明或定义，不算待验：01:7（标注说明）、03:5（标注说明）、03:43（「证据分级」的定义）、04:5（标注说明）、04:107（`finding.grade` 的取值表）、05:5（P1* 的定义）、06:50（A2.5 的 P1* 写法）、07:5（标注说明）、07:79（记的是一条已回答的旧待验项）、07:99（参数表的标注说明）、09:11（标注说明）、10:5（标注说明）、11:5（标注说明）、12:5（标注说明）、12:9（`12` 自己的引用规则）、13:3（标注说明）。其余 90 处逐条列在 §3。下文「03:37」这样的写法指 `docs/03-…` 第 37 行。
- NOTES：`NOTES.md` 最后 25 格（L510 发布 0.7.1 到 L633 全面审查后的遗留修正）的「卡在哪」，一格里有几条线程就拆几行，共 55 行，列在 §4。
- 状态：**已关闭** = 后来的实测、测试或代码事实回答了它（写了依据）；**仍开** = 没有排期，仍值得验或待作者定；**不再追** = 不需要再验（方案改了、组件没做、只是背景判断或设计取舍），原文留作记录；**需作者本机** = 只能在作者的机器、账号或真人操作下验；**需真实站点** = 只能在真实站点上验（AGENTS.md：guard 落地前本仓库的 AI 不对靶场外的站点发请求）；**已排期（包）** = 本波（10-21 审查修正）有包在处理：打码、guard、Chrome、发布、结构、config，另有 store、cli、types、testhelpers 四个小包。

## 2. 汇总

| 状态 | docs 标记 | NOTES 线程 | 合计 |
|---|---|---|---|
| 已关闭 | 18 | 28 | 46 |
| 仍开 | 27 | 12 | 39 |
| 不再追 | 32 | 10 | 42 |
| 需作者本机 | 8 | 3 | 11 |
| 需真实站点 | 8 | 2 | 10 |
| 已排期 | 0 | 0 | 0 |
| 合计 | 93 | 55 | 148 |

## 3. docs 里的标记

| # | 位置 | 标记 | 原句摘要 | 状态 | 依据 / 去向 |
|---|---|---|---|---|---|
| 1 | `docs/01-background-and-options.md:50` | 推断 | 方案 D 只改配置：抢焦点大概率还在 | 不再追 | 10-15 的选项比较，方案已定为 `direct`（`03` §8） |
| 2 | `docs/01-background-and-options.md:52` | 推断 | 方案 B 薄层自建：MVP 2–4 天 | 不再追 | 同上，工期估计 |
| 3 | `docs/03-product-thesis-and-roadmap.md:19` | 推断 | 市面上为什么不这么做（四条原因） | 不再追 | 背景判断，不需要验 |
| 4 | `docs/03-product-thesis-and-roadmap.md:37` | 待验 | 真人的 OS 输入在本机由人操作时是否同样触发人接管 | 需作者本机 | NOTES 0.7.1 发布格（L512）：作者真实的鼠标点击（Cloudflare 验证框、npm 安全密钥）被识别为接管，鼠标这一项有了一次真人实测；键盘、触控板、拖滚动条、自动填充、输入法仍没有 |
| 5 | `docs/03-product-thesis-and-roadmap.md:161` | 推断，待验 | 识别人接管：靠守护进程记自己发输入的时间窗来区分 | 已关闭 | 0.7.1-A 按此实现，e2e v071a 证明了机制（`04` §37）；真人输入那一半见 03:37 |
| 6 | `docs/03-product-thesis-and-roadmap.md:169` | 待验 | Chrome for Testing 与正式版的指纹是否完全一致 | 仍开 | 要正式版 Chrome 的画像对照；浏览器参照语料在私有仓库（`08` §3） |
| 7 | `docs/04-evidence-bundle-spec-v0.md:67` | 推断，待验 | `actor` 的 P1 规则（命令窗口内算 ai），更精确的识别是 P2 | 仍开 | 0.7.1-A 让等人期间的输入记成 `actor:"human"`（`04` §37）；命令窗口之外的请求仍按 P1 规则归属 |
| 8 | `docs/04-evidence-bundle-spec-v0.md:188` | 待验 | `maxPostDataSize` 等缓冲参数在 `ext` 路径下是否生效，具体取值靠 s12 量 | 仍开 | `ext` 半句随 ext 未实现不再追；取值要 s12 量，s12 未落地（`05` §20） |
| 9 | `docs/04-evidence-bundle-spec-v0.md:464` | 推断 | recon 的 `stack` 判断全部是推断 | 不再追 | 设计如此：适配器与头 / cookie 标记只给推断级结论 |
| 10 | `docs/04-evidence-bundle-spec-v0.md:505` | 待验 | `<a target=_blank>`（默认 noopener）的新标签是否带 `openerId`、因而是否进会话 | 仍开 | 靶场可加一个 s17 变体验 |
| 11 | `docs/04-evidence-bundle-spec-v0.md:506` | 推断 | 真实站点的根因是「请求返回后才开弹窗」 | 需真实站点 | 复测时没有原始日志，只能在那个站点上再看 |
| 12 | `docs/04-evidence-bundle-spec-v0.md:506` | 待验 | 靶场没有「慢请求后开弹窗」的页面，这条路径只有单测 | 仍开 | 要在 `05` 加场景，待作者定 |
| 13 | `docs/04-evidence-bundle-spec-v0.md:580` | 推断 | `deps --write-findings` 对明文视图上的来源分级为推断 | 不再追 | 分级规则，设计如此 |
| 14 | `docs/04-evidence-bundle-spec-v0.md:633` | 推断 | `usage` 里 `evaluate` 按命令窗口归属，窗口里页面自己的请求也算 evaluate | 不再追 | 已知近似，写在规范里 |
| 15 | `docs/04-evidence-bundle-spec-v0.md:868` | 推断 | 观察模式零行的根因（walk 前读 suspect） | 已关闭 | 原句已写「修后不再复现」（0.6-L2） |
| 16 | `docs/04-evidence-bundle-spec-v0.md:875` | 待验 | Worker `postMessage` 对象（结构化克隆）的 `trace --decode` | 仍开 | 靶场 s59 只有「worker 回字符串」；对象克隆要新变体 |
| 17 | `docs/04-evidence-bundle-spec-v0.md:881` | 推断 | 真实站点验收：页面在 tabcap 索引响应之前就 parse 了 | 需真实站点 | 现象来自真实站点验收 |
| 18 | `docs/04-evidence-bundle-spec-v0.md:901` | 推断 | 修 `location.scriptId` 后 tabcap 自己 `evaluate` 里的 `JSON.parse` 不再进观察路径 | 仍开 | 靶场没有专门断言，可补 |
| 19 | `docs/04-evidence-bundle-spec-v0.md:927` | 推断 | 方案 B（`Fetch.requestPaused` Response 阶段武装）的代价 | 仍开 | 方案 B 没有做（NOTES 0.7.1、0.7.3 格的候选清单），代价随之未验 |
| 20 | `docs/04-evidence-bundle-spec-v0.md:935` | 推断 | 缺 ACAC 那一种 CORS 理由的 Chrome 原文 | 仍开 | 靶场可补一个缺 ACAC 的端点取原文 |
| 21 | `docs/04-evidence-bundle-spec-v0.md:936` | 推断 | 页面 `fetch()` 的跨源 `referrer` 被换成 `about:client` | 仍开 | 读规范得出，靶场可实测 |
| 22 | `docs/04-evidence-bundle-spec-v0.md:971` | 推断 | 验收里的 CSRF 值来自解码插件视图，旧代码于是落到环境变量 | 已关闭 | 单测在 s42 合成包上复现（`test/unit/replay-chain.test.ts`） |
| 23 | `docs/04-evidence-bundle-spec-v0.md:976` | 推断 | 验收报告里「没有录制时触发」应是截图还没拍完 | 不再追 | 对一份旧验收报告的解释；代码已改为等截图（最多 5 s） |
| 24 | `docs/04-evidence-bundle-spec-v0.md:984` | 待验 | 跨进程 iframe（OOPIF）里的人输入不覆盖 | 仍开 | 已知盲区：OOPIF 是单独挂上的目标，监听器只装在标签自己的会话上 |
| 25 | `docs/04-evidence-bundle-spec-v0.md:987` | 推断 | 人接管时后台标签截图可能要开焦点仿真，人看着的页面会短暂变化 | 不再追 | 设计取舍：人接管时不截图 |
| 26 | `docs/04-evidence-bundle-spec-v0.md:992` | 待验 | 真人的 OS 输入（鼠标、键盘、触控板、滚动条、自动填充、输入法） | 需作者本机 | 同 03:37 |
| 27 | `docs/04-evidence-bundle-spec-v0.md:1020` | 待验 | 真人登录、跨域单点登录把 cookie 种在别的域 | 需真实站点 | — |
| 28 | `docs/04-evidence-bundle-spec-v0.md:1029` | 待验 | `ext` 模式下 `navigator.webdriver` 的值 | 不再追 | ext 未实现（`03` §5、§7）；做 ext 时先量 |
| 29 | `docs/04-evidence-bundle-spec-v0.md:1067` | 待验 | 防护家族规则在真实站点上的命中率与误报 | 需真实站点 | 等作者真实项目的包（NOTES 0.8-A1 格） |
| 30 | `docs/05-local-range-scenarios.md:175` | 推断，待验 | 一天 soak：direct 模式独立 profile 不弹「允许远程调试」 | 已关闭 | spike 1 已实测：direct 模式唯一的弹框是 macOS 钥匙串，`--use-mock-keychain` 消除（`06` §6、`07` §1.1）；一天 soak 与 `tabcap soak` 命令都没有做 |
| 31 | `docs/05-local-range-scenarios.md:234` | 待验 | s46：提案里 Playwright 打 'B' 是否按 Shift 的待验「由此定」 | 已关闭 | 原句记的就是关闭（实测 10-15：不按 Shift）；这一段在 `05` 里重复了一遍（L234、L235） |
| 32 | `docs/05-local-range-scenarios.md:235` | 待验 | 同上（重复的那一段） | 已关闭 | 同上 |
| 33 | `docs/05-local-range-scenarios.md:300` | 待验 | s59：Worker 回对象（结构化克隆）没有对应 e2e | 仍开 | 同 04:875 |
| 34 | `docs/05-local-range-scenarios.md:321` | 待验 | s62：真人的 OS 输入 | 需作者本机 | 同 03:37 |
| 35 | `docs/05-local-range-scenarios.md:346` | 待验 | s65：真人登录、跨域单点登录的 cookie | 需真实站点 | 同 04:1020 |
| 36 | `docs/05-local-range-scenarios.md:356` | 待验 | s66：`ext` 模式的 webdriver 值 | 不再追 | 同 04:1029 |
| 37 | `docs/05-local-range-scenarios.md:380` | 待验 | s67–s70：真实站点上的命中与误报 | 需真实站点 | 同 04:1067 |
| 38 | `docs/05-local-range-scenarios.md:390` | 待验 | s71：作者真实使用里要加的那几个参数本身的效果 | 需作者本机 | 参数只有作者知道（NOTES 0.8.1-A 格） |
| 39 | `docs/06-phase1-acceptance-test-plan.md:26` | 待验 | 黑洞代理是否把 Chrome 的外连完全截断（没抓包） | 仍开 | `--proxy none` 时由 `launcher.ts` 加上；从 spike 2 起没抓过包核对 |
| 40 | `docs/06-phase1-acceptance-test-plan.md:27` | 推断，待验 | `ext` 模式下与其它挂 debugger 的扩展共存 | 不再追 | ext 未实现 |
| 41 | `docs/07-bridge-architecture-and-cdp-compat.md:18` | 推断，待验 | 扩展经 `chrome.debugger` 拿到 `sessionId`（Chrome 125 起） | 不再追 | 扩展与 ext 都没做 |
| 42 | `docs/07-bridge-architecture-and-cdp-compat.md:21` | 推断 | 薄扩展每条命令多一跳本机 WebSocket，亚毫秒 | 不再追 | 扩展没做 |
| 43 | `docs/07-bridge-architecture-and-cdp-compat.md:27` | 推断 | 钥匙串「始终允许」换版本大概率再弹 | 不再追 | 已改用 `--use-mock-keychain`，不依赖钥匙串 |
| 44 | `docs/07-bridge-architecture-and-cdp-compat.md:29` | 待验 | 黑洞代理把外连全部截断 | 仍开 | 同 06:26 |
| 45 | `docs/07-bridge-architecture-and-cdp-compat.md:44` | 推断 | V8 内建函数的断点跨上下文共享 | 不再追 | 现象已按实测处理（丢弃隔离世界的暂停），原因不影响实现 |
| 46 | `docs/07-bridge-architecture-and-cdp-compat.md:64` | 推断 | 帧里点击的平移没算 iframe 上的 CSS transform / 缩放 | 仍开 | 已知限制，靶场可加带 transform 的 iframe 验 |
| 47 | `docs/07-bridge-architecture-and-cdp-compat.md:64` | 待验 | OOPIF 里打开文件选择框时 `Page.fileChooserOpened` 落在哪个会话 | 仍开 | — |
| 48 | `docs/07-bridge-architecture-and-cdp-compat.md:78` | 待验 | 前台是 Firefox Developer Edition 时的前台归还修复后复测 | 需作者本机 | 只有作者的 Mac 上有这个前台应用 |
| 49 | `docs/07-bridge-architecture-and-cdp-compat.md:81` | 推断 | `navigate --new-tab` 开的后台标签是否从未绘制过 | 不再追 | 实现按「开仿真后 rAF 按时回调」的实测走，与此无关 |
| 50 | `docs/07-bridge-architecture-and-cdp-compat.md:83` | 推断 | 后台标签每秒 1 帧的原因（surface 不在合成树里） | 不再追 | 原因推断；修法（screencast 保持出帧）已实测 |
| 51 | `docs/07-bridge-architecture-and-cdp-compat.md:93` | 推断 | 间隔约 250 ms 的第二次注入被页面侧合并吞掉 | 不再追 | 按设计；测试改隔 400 ms |
| 52 | `docs/07-bridge-architecture-and-cdp-compat.md:94` | 待验 | 真人的 OS 输入：是否同样可信、时延、滚动条、自动填充、输入法 | 需作者本机 | 同 03:37 |
| 53 | `docs/07-bridge-architecture-and-cdp-compat.md:103` | 待验 | spike 1 看到的 GCM 外连在 `--disable-features` 这组之下是否消失 | 仍开 | 与 06:26 同一类，没抓过包 |
| 54 | `docs/07-bridge-architecture-and-cdp-compat.md:107` | 待验 | `CDPScreenshotNewSurface` 对后台标签截图的效果 | 已关闭 | `src/daemon/tools/page.ts` `captureTab` 的注释：隐藏标签经它出图（实测 10-15），纯色图与 `Unable to capture screenshot` 两种失败由焦点仿真兜底（NOTES 0.3-C） |
| 55 | `docs/07-bridge-architecture-and-cdp-compat.md:112` | 推断 | 只以 `--remote-debugging-pipe` 启动时 webdriver 为 true，是因为管道连接即视为自动化 | 不再追 | 0.7.6-A 起默认隐藏（`04` §40），原因不再影响行为 |
| 56 | `docs/07-bridge-architecture-and-cdp-compat.md:184` | 推断 | 绑 `system` / `none` 的账号的 context 走启动参数里的代理设置 | 仍开 | 只有非 loopback 地址才看得出差别，靶场只发 127.0.0.1；可用 `fwdproxy` 映射的主机名验 |
| 57 | `docs/07-bridge-architecture-and-cdp-compat.md:184` | 待验 | 同上 | 仍开 | 同上 |
| 58 | `docs/07-bridge-architecture-and-cdp-compat.md:219` | 待验 | windsurf 的官方配置页已跳到 Devin Desktop | 仍开 | 要重读官方文档，核对 `--print-config windsurf` |
| 59 | `docs/07-bridge-architecture-and-cdp-compat.md:229` | 待验 | Python 助手 `_tabcap_fetch.py` 的 Windows 路径 | 已关闭 | Windows CI 跑 `test/unit/pyfetch075a.test.ts`（回环 TCP + token 的 `daemon.json`，NOTES 0.7.5 发布格记了它在 windows-latest 上跑） |
| 60 | `docs/08-implementation-plan.md:64` | 待验 | Windows 待验项：管道句柄、`--no-startup-window`、守护进程监听、权限 ACL、CfT win64 下载 | 已关闭 | 0.3-G 起 Windows 用回环 TCP + 每次启动的 bearer 令牌、`Expand-Archive` 解压、跳过前台归还，Windows CI 单测与 e2e 都在跑（NOTES 0.3-G、0.7-F、0.7.3-A 审查补修格）；余项：Windows 不查文件权限（ACL 等效性没验），Windows 包没在真机跑过 |
| 61 | `docs/09-recon-and-page-understanding.md:7` | 待验 | `09` 里各 UI 库、框架、协议的特征没在本机逐一验过 | 仍开 | `09` 仍是草案；落地一项先用靶场验一项 |
| 62 | `docs/09-recon-and-page-understanding.md:440` | 待验 | GBK 等字符集在 Bun 的 `TextDecoder` 里是否可用 | 已关闭 | 实测 2026-10-21（Bun 1.4.3）：`new TextDecoder("gbk")` 的 `encoding` 为 `gbk`，字节 `d6 d0 ce c4` 解出「中文」；`09` 原处的标记没改 |
| 63 | `docs/10-input-fidelity-proposal.md:72` | 推断 | 有头运行开头那组 pointer 事件来自窗口出现在光标下 | 不再追 | oracle 改取无头运行，与此无关 |
| 64 | `docs/10-input-fidelity-proposal.md:74` | 推断 | Playwright 按下时带 `force: 0.5` | 已关闭 | `07` §1.1：`force:0.5` 让 pressure 为 0.5，与 Playwright 导出一致（实测 10-15） |
| 65 | `docs/10-input-fidelity-proposal.md:74` | 待验 | 同上，在实现格里用探针确认 | 已关闭 | 同上 |
| 66 | `docs/10-input-fidelity-proposal.md:76` | 推断 | pipe 方式本身让 webdriver 为 true | 不再追 | 同 07:112 |
| 67 | `docs/10-input-fidelity-proposal.md:92` | 待验 | Playwright 打 'B' 时是否带 Shift | 已关闭 | `05` s46：不按 Shift（实测 10-15） |
| 68 | `docs/10-input-fidelity-proposal.md:111` | 推断 | 方案 B 每次点击多花约 0.15–0.55 s | 不再追 | 提案期估算；落地后的实测见 `07` §1.1（完整路径约 0.85 s） |
| 69 | `docs/10-input-fidelity-proposal.md:118` | 待验 | 大写和符号是否先发 Shift 的 keyDown | 已关闭 | 同 10:92 |
| 70 | `docs/10-input-fidelity-proposal.md:123` | 待验 | 逐键发送时 `raw/cdp.jsonl` 与守护进程日志是否记下发出的 `Input.*` 参数 | 已关闭 | `06` A7.10，e2e `v03e`：逐键打的密码不进守护进程日志、CLI 输出与证据包，单字符拼也拼不出 |
| 71 | `docs/10-input-fidelity-proposal.md:129` | 推断，待验 | 轨迹起点取 (0,0) | 不再追 | 实现按此做；A7.1 只断言终点与形状，起点没有 oracle 要求 |
| 72 | `docs/10-input-fidelity-proposal.md:132` | 待验 | `force:0.5` 对齐 pressure 差异 | 已关闭 | 同 10:74 |
| 73 | `docs/10-input-fidelity-proposal.md:140` | 推断 | rAF 回调说明合成器已为该页出帧 | 不再追 | 判定规则的理由；验证见下一条 |
| 74 | `docs/10-input-fidelity-proposal.md:140` | 待验 | 从未绘制过的后台标签开仿真后 rAF 是否一定按时回调 | 已关闭 | `07` §1.1 实测 10-15：`navigate --new-tab` 开的后台标签开仿真后 rAF 按时回调；该标签是否「从未绘制过」本身仍是推断（07:81） |
| 75 | `docs/10-input-fidelity-proposal.md:149` | 推断 | 守护进程内部的其它路径会直接调 `send`，代理层接不住 | 不再追 | 实现约束的说明 |
| 76 | `docs/10-input-fidelity-proposal.md:161` | 推断 | 输入保真不需要新增启动参数 | 不再追 | 提案期判断 |
| 77 | `docs/10-input-fidelity-proposal.md:222` | 待验 | 修饰键（Shift）一项要等夹具补齐字段 | 已关闭 | 同 10:92 |
| 78 | `docs/11-wire-fingerprint-spec.md:58` | 推断 | 扩展体畸形整份丢弃；CLI 测试只覆盖非 ClientHello 的输入 | 仍开 | 可补畸形 ClientHello 的 CLI 测试 |
| 79 | `docs/11-wire-fingerprint-spec.md:107` | 推断 | `message_length` 含 4 字节握手头 | 仍开 | 可对照 RFC 8446 §4 与 Wireshark 核 |
| 80 | `docs/11-wire-fingerprint-spec.md:146` | 推断 | GREASE 值每次重抽，位置是否固定因客户端而异（RFC 8701） | 不再追 | 引自规范；画像按位置记录，不依赖这条 |
| 81 | `docs/11-wire-fingerprint-spec.md:148` | 推断 | `key_shares` 组固定、公钥每次随机 | 不再追 | 同上 |
| 82 | `docs/11-wire-fingerprint-spec.md:150` | 待验 | `fe0d`（GREASE ECH）长度在两份样本里不同，是否与 PSK 无关 | 仍开 | 要更多样本 |
| 83 | `docs/11-wire-fingerprint-spec.md:151` | 推断 | 去 GREASE 后的各列表与 h2 帧参数稳定 | 不再追 | 画像用 `stable_across_samples` 按样本记录，以画像为准 |
| 84 | `docs/12-comparison.md:11` | 待验 | 经 WebFetch 抽取的引文是否逐字 | 不再追 | 对照文档的引文精度，只作参考 |
| 85 | `docs/12-comparison.md:121` | 待验 | s22 对照：`deps` 把 `q` 算常量，没关联到帧里的 `fill` | 仍开 | 帧内 fill 与请求参数的关联没查（`12` 留给后续格） |
| 86 | `docs/12-comparison.md:131` | 待验 | agent-browser 的 HAR 缺 `/s22/table` 等正文的原因 | 不再追 | 别家产品一次运行的现象，按 `12` 的规则不推断其实现 |
| 87 | `docs/12-comparison.md:135` | 待验 | §4.3 没跑的对照行（Integuru、Unbrowse 托管） | 不再追 | 要第三方账号或托管服务，不跑 |
| 88 | `docs/13-interop-proxies.md:55` | 待验 | mitmproxy / Burp 做 https 中间人时 Chrome 信任代理 CA | 需作者本机 | 要在作者机器上装代理 CA |
| 89 | `docs/13-interop-proxies.md:113` | 待验 | Burp Logger++ 导出 HAR 再导入 | 需作者本机 | Burp 在作者手里；作者 10-16 定 Burp 后做 |
| 90 | `docs/14-protection-families.md:7` | 推断 | 家族表里的信号都是推断（来自公开来源） | 需真实站点 | 同 04:1067 |
| 91 | `docs/04-evidence-bundle-spec-v0.md:1162` | 待验 | Service Worker 应答、prerender 激活的导航的 `responseStatus`（0.9-A，10-23 加） | 仍开 | 靶场没有这两种页 |
| 92 | `docs/04-evidence-bundle-spec-v0.md:1206` | 待验 | 作者要采的 LLM 聊天站的回答流是不是 `text/event-stream`（0.9-C，10-23 加） | 需真实站点 | 作者在 GEO 项目里录一次确认；二进制分帧的类型要另加 |
| 93 | `docs/04-evidence-bundle-spec-v0.md:1219` | 推断 | 网络中断的下载 CDP 也报 `canceled`（0.9-D，10-23 加） | 仍开 | 靶场可造（下载中途重置连接），0.9-D 的 e2e 没覆盖 |

## 4. NOTES 最近 25 格的「卡在哪」

| # | 格（NOTES 行） | 线程 | 状态 | 依据 / 去向 |
|---|---|---|---|---|
| 1 | L512 发布 0.7.1 | 作者真实鼠标点击（Cloudflare 验证框、npm 安全密钥）被识别为接管 | 已关闭 | 这是记下的真人实测；其余真人输入见 03:37 |
| 2 | L512 发布 0.7.1 | `tabcap wait` 一次只收一个条件；npm 的 2FA 页 URL 不变、只能看文字 | 不再追 | 0.7.5-B 的 `handoff wait --until-*`（含 `--until-text`）覆盖了交接的这一用法 |
| 3 | L512 发布 0.7.1 | Windows 单测偶发超时要不要单独放宽到 30 s | 仍开 | 待作者定 |
| 4 | L517 0.7.2-A | Windows 上 `Bun.spawn` 能否直接跑 `npm.cmd` | 已关闭（第一波发布包，PR #31） | — |
| 5 | L517 0.7.2-A | npm 渠道的真实升级（全局 prefix 无写权限、npm 由 nvm 管理） | 需作者本机 | — |
| 6 | L517 0.7.2-A | `TABCAP_NPM_REGISTRY` 只改查询地址，不传给 `npm install` | 仍开 | 本波没有包领 |
| 7 | L522 发布 0.7.2 | 发布 Release、新建公开 tap 仓库要作者在网页上做 | 已关闭 | NOTES 10-19「Homebrew 分发上线」格 |
| 8 | L522 发布 0.7.2 | formula 每版手动更新，自动化要写 tap 的 PAT | 已关闭 | `homebrew.yml` + `HOMEBREW_TAP_TOKEN`（同上） |
| 9 | L522 发布 0.7.2 | v0.7.1 的草稿 Release 删不删 | 仍开 | 待作者定（L542 又提一次） |
| 10 | L527 Homebrew tap 自动化 | tap 仓库和 PAT 要作者建 | 已关闭 | 同 L522 |
| 11 | L527 Homebrew tap 自动化 | Scoop 没做 bucket | 仍开 | 未排期；清单在 `packaging/scoop/` |
| 12 | L527 Homebrew tap 自动化 | loreweaver 没有 brew / scoop 分发 | 不再追 | 另一个项目 |
| 13 | L532 0.7.3-A | 分支基线与误提交的说明 | 不再追 | 历史说明，没有开放项 |
| 14 | L537 0.7.3-A 审查补修 | Windows 的结果只能靠 CI 验证 | 已关闭 | PR 上 CI 绿后合入，0.7.3 已发布（L540） |
| 15 | L542 发布 0.7.3 | 两条 e2e「两种合法结果、测试只认一种」 | 已关闭 | 测试已改 |
| 16 | L542 发布 0.7.3 | loreweaver-protocol 的 trusted publisher 要在截止前真发一次 | 不再追 | 另一个项目 |
| 17 | L547 合并后 CI 追绿 | 「测试一返回就读录制」的时序断言，再出现按同样套路改 | 仍开 | 常规做法；`scripts/ci-flakes.ts` 记台账 |
| 18 | L552 Homebrew 分发上线 | 本机 `brew install 1A7432/tabcap/tabcap` 的安装验证 | 已关闭 | 0.7.4 发布格：本机 `brew upgrade tabcap` 到 0.7.4，`tabcap update --check` 识别为 homebrew 渠道（实测） |
| 19 | L557 update 加 Homebrew 渠道 | 真实 `brew upgrade` 端到端走一遍 | 已关闭 | 同上 |
| 20 | L562 沙箱里的 Chrome | Linux `No usable sandbox!` 标志行没在 bubblewrap 里实测 | 已关闭（第一波发布包，PR #31） | — |
| 21 | L562 沙箱里的 Chrome | 沙箱内客户端能否连沙箱外守护进程的 socket（各家不同） | 已关闭（第一波发布包，PR #31） | 现在只在文档里建议整个 tabcap 放沙箱外 |
| 22 | L567 CI 提速 | 分片后的实际总时长 | 已关闭 | 0.7.4 发布格：分片后 CI 4 分 39 秒全绿（实测） |
| 23 | L572 0.7.4 发布 | 用 `tabcap update` 真正跑一次 `brew upgrade` | 已关闭 | 0.7.5 发布格：`tabcap update` 走 homebrew 渠道跑了 `brew upgrade tabcap`，回 `installed`，版本 0.7.5（实测） |
| 24 | L577 0.7.5-A / B | 站点级 `json:$.code!=0` 在 HTML 文档上命中 | 已关闭 | 0.7.5-C：`json:` 规则只评判 JSON 正文 |
| 25 | L577 0.7.5-A / B | SKILL.md 只剩 2 字节余量，加东西先挪到 references | 仍开 | 长期约束 |
| 26 | L577 0.7.5-A / B | 真人登录、跨域 SSO 的 cookie 按标签 URL 看不到 | 需真实站点 | 同 04:1020 |
| 27 | L577 0.7.5-A / B | Python `ListEnd` 只用假守护进程测过，没接真 e2e | 仍开 | — |
| 28 | L582 0.7.5-C | 「API 回 HTML 就停」改由 `text:^\s*<` 写，没加新规则种类 | 不再追 | 设计决定，已写进文档 |
| 29 | L587 0.7.5 发布 | `~/.claude/skills/tabcap` 是未改动的 0.7.3 副本，覆盖与否 | 需作者本机 | 作者本机的状态；发布包的悬空线程清单也列了它 |
| 30 | L587 0.7.5 发布 | Windows `npm.cmd` 路径 | 已关闭（第一波发布包，PR #31） | 同 L517 |
| 31 | L587 0.7.5 发布 | Linux 沙箱标志行 | 已关闭（第一波发布包，PR #31） | 同 L562 |
| 32 | L592 0.7.6-A | 本机 Zig 0.17 编不了 wireprint，v04w 本机跑不了 | 已关闭（第一波发布包，PR #31） | — |
| 33 | L592 0.7.6-A | 线指纹画像缓存按参数哈希失效，第一次 `wire probe` 会重采 | 仍开 | — |
| 34 | L592 0.7.6-A | `ext` 模式的 webdriver 值没量 | 不再追 | 同 04:1029 |
| 35 | L597 0.7.6 发布 | `ext` 模式 webdriver 值；本机 Zig 0.17 跑不了 v04w | 已关闭（第一波发布包，PR #31） | ext 那半不再追（同 04:1029）；Zig 那半同 L592 |
| 36 | L602 CI 稳定 | v06j 的 3 s 余量是推断，没有真实时延证据 | 仍开 | 等下次 CI 失败时看 `checks` 计数 |
| 37 | L602 CI 稳定 | 其他 e2e 里按 `net list` 顺序断言的地方没逐个审 | 仍开 | 本波没有包领 |
| 38 | L607 0.8-A1 | F5 BIG-IP ASM 只有 `TS` 短前缀，进 backlog；AWS `challenge.js` 没来源，不收 | 不再追 | 在 backlog / 不收 |
| 39 | L607 0.8-A1 | 音频 / WebRTC / 电量等指纹技术要先扩追踪名单 | 仍开 | 改追踪默认行为，待作者定 |
| 40 | L607 0.8-A1 | 真实站点上的命中与误报 | 需真实站点 | 同 04:1067 |
| 41 | L612 0.8-A2 / A3 | 实时探测不读响应头与状态码，521 / 412 规则只在 recon 里生效 | 不再追 | 设计取舍，`04` §41.3 已写明 |
| 42 | L612 0.8-A2 / A3 | 每次导航多一次探测对其他 e2e 时序的影响 | 已关闭 | 0.8.0 发布格：PR #25 第二、三轮 CI 全绿；探测在主世界执行的问题另有 Chrome 包处理 |
| 43 | L617 PR #25 第一轮 CI | v04w 的 echo 竞态没证实，要在 CI 上 flake-hunt | 不再追（10-22 CI flake-hunt run 39630763226：ubuntu / windows 各 10 次全绿，未复现） | — |
| 44 | L622 0.8.0 发布 | v04w 的 echo 竞态 | 不再追（同 L617） | 同 L617 |
| 45 | L628 0.8.1-A | 本机 Zig 0.17 编不了 wireprint | 已关闭（第一波发布包，PR #31） | 同 L592 |
| 46 | L628 0.8.1-A | 作者实际要加的那几个参数本身的效果 | 需作者本机 | 同 05:390 |
| 47 | L635 遗留修正 | `fetch --batch` 进入 waiting 后继续发；交接标签关闭即 no-tab；human-takeover 不补探测；§41.3「trace stop 写汇总」；`--until-text` 主帧主世界轮询；`next` 不带 `--session`；CLI 与守护进程无版本握手 | 已关闭（第一波 guard 包，PR #31） | — |
| 48 | L635 遗留修正 | 导出打码按 kind 白名单、敏感头集合比实时窄；实时打码不覆盖交接与 status；两套 query 打码；两套 `redactDossier` | 已关闭（第一波打码包，PR #31） | — |
| 49 | L635 遗留修正 | `--proxy` userinfo 与 `--chrome-arg` 路径进 manifest；`--drop-chrome-arg` 能删代理开关；`--chrome-arg` 照传危险开关；实时探测在主世界执行 | 已关闭（第一波 Chrome 包，PR #31） | — |
| 50 | L635 遗留修正 | config.json 解析失败静默当空、`setup` 整份覆写；未知键静默忽略 | 已关闭（第三波 config 包，分支 w3/config） | 解析不出（或顶层不是对象）时每个读配置的命令回 `bad-input` 并给行列，`setup` 不改写，回放键规则走同一个 `readConfigRaw`；未知键进 `warnings`（`browser start` / `browser status`、`status` 的 `config.warnings`、`setup`），键表 `CONFIG_KEYS` 生成 `skills/tabcap/references/config.md`；`04` §44，单测 `config-strict` / `config-keys` |
| 51 | L635 遗留修正 | 三套 siteOf；`tools/snapshot.ts` 循环依赖；三套 JSON 路径方言；`replay check --live` 绕过 guard | 已关闭（第二波结构包，PR review-wave2） | — |
| 52 | L635 遗留修正 | Scoop hash 跟不上版本；release.yml 不要求同一提交 CI 全绿；NOTES 悬空线程（brew upgrade、Windows npm.cmd、Linux 沙箱行、`~/.claude/skills`、v04w） | 已关闭（第一波发布包，PR #31） | brew 两条按上表已关闭 |
| 53 | L635 遗留修正 | types.ts 事件类型已非契约；CLI 三条解析路径；store 只增不减与占位表；HAR `--embed-events` 往返；测试替身重复 | 已关闭（第二/三波，PR #32 / #33） | 本波另外四个包 |
| 54 | L635 遗留修正 | `bundle info --usage` 按 actor 计数要加 `human` | 仍开 | 本波没有包领 |
| 55 | L635 遗留修正 | docs/04 24 节「待作者审」；docs/03 §5 描述不存在的扩展；`test:range` / `verify` 占位；docs/05 与 docs/09 的 s41 / s42 撞号 | 已关闭 | 本包（文档与流程）：作者 10-21 批量签收、`03` 标状态、删占位脚本、改号并建 `05` 场景索引（今 §20） |
