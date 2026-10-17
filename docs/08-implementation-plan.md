# 阶段 1 实现方案（10-15 作者审过）

执行方式：每格由 Opus 子 agent 实现，主循环（Fable）审查验收；每格以测试通过和 NOTES 三行收尾。规范以 `04`–`07` 为准，本文只定布局、边界和顺序。

## 1. 仓库

- 在本目录 `git init`，独立 git 仓库；本地第三方材料目录已忽略。定名后整个目录 `mv` 出去，历史不丢。
- 代码里一律用占位符 `bbl`（包名、二进制名、`~/.config/bbl/`、`~/.cache/bbl/`），改名只换常量。
- 单包多入口；`bun build --compile` 出一个二进制同时充当 CLI 和守护进程（`tabcap daemon start` 自我派生）。
- 依赖尽量零：Bun 自带 WebSocket、`Bun.serve`、`bun:sqlite`、测试器、gzip；HAR、解码链手写。类型可能要 `devtools-protocol`、`@types/chrome`，本机 npm 不稳是唯一风险。
- 许可证 Apache-2.0；抄 Playwright（参数表、cdpRelay 思路）要在 NOTICE 记。

## 2. 布局

```
browser-bridge-lab/
  package.json  tsconfig.json  bunfig.toml  LICENSE  NOTICE  .editorconfig
  src/
    shared/      envelope.ts  ids.ts  time.ts  log.ts
    bundle/      types.ts  manifest.ts  blobs.ts  writer.ts  reader.ts  har.ts  redact.ts
    daemon/
      main.ts    Bun.serve 监听 Unix socket ~/.config/tabcap/daemon.sock（0600）；pid、日志
      transport/ types.ts（Transport 接口）direct/（launcher、pipe/port、CDP 客户端、挂接协议、就绪判定）ext/（阶段 2 占位）
      browser/   targets.ts（会话 ↔ 标签、owned/borrowed、nav 纪元）focus.ts（三级阶梯）dialogs.ts（页锁）
      tools/     navigate  snapshot  click  fill  evaluate  screenshot  tabs  session
      capture/   recorder.ts（Network 急取 + Fetch 拦截 XHR/Fetch/Document + 导航提交收尾 → bundle）
      store/     db.ts（bun:sqlite）secrets.ts（引用解析 + 输出替换）
      guard/     最小版        handoff/  最小版
    cli/         main.ts + commands/*.ts（只做参数解析和打印）
    analyze/     find.ts  decoders.ts  diff.ts
  extension/     MV3，阶段 1 只有角标和只读状态条
  range/         server.ts + scenarios/sNN/{page.html, api.ts, expected.json, README.md}
  fixtures/      bundles/  har/
  test/          unit/（L0）range/（L1）e2e/（L2）
```

边界：
- CLI 不含业务逻辑，只是守护进程 API 的壳；L2 走 CLI 即测契约。
- `transport` 只暴露 CDP 级接口（attach / send / events）；`browser/` 以上不知道底下是 pipe 还是扩展。
- `bundle/` 与 `analyze/` 不依赖守护进程：纯函数 + 文件，L0 可测。
- 所有外部输入（CDP 事件、HAR、页面内容）当不可信数据；禁止 `as any` / `!` 绕类型。

## 3. 顺序

| 格 | 做什么 | 验收 |
|---|---|---|
| 1 | `git init`、脚手架、`bundle` 写读、manifest、blobs、HAR 导入导出、脱敏、`tabcap bundle` 子命令 | L0：`04` §11 样例往返、§9.3 三条性质 |
| 2 | `range` 服务端 + s01、s02 + journal + `selftest` | L1 |
| 3 | `direct` 传输层：`setup`（CfT JSON API 下载到 `~/.cache/tabcap/`）、`07` §1.2 参数表、pipe、挂接协议、就绪判定；`daemon` / `browser` / `session` / `navigate` / `evaluate` | L2：s01；A1.1 |
| 4 | `capture` 录制器接 bundle | A2.1 s02、A2.3 s13 |
| 5 | `snapshot`、`click` / `fill`（阶梯一、二级）、`screenshot`、`tabs`；`store` 最小版 | A2.7、A2.9 s07 |
| 6 | `analyze find` + 解码链（s04、s05）、`analyze diff`（s06） | A3、A4 |
| 7 | 最小 guard / handoff（s15）、`bun run verify` 矩阵、扩展角标、A1.2 | A5、A6、A1.2 |
| 8 | s03、s08–s14，HAR 导入夹具，skill 文件 | 补齐 P1 |

0.3（10-15 作者定）：`store` + `fill --secret` + 最小 guard（含挑战识别：验证码、滑块、短信、JS 挑战、风控页，默认交人，并提供统一的外部插件接口，插件目录 `~/.config/tabcap/plugins/`，主仓库不含任何解法；接口要能承载作者自己研究项目的插件）→ `replay serve` → 适配器框架（注册表 + 第一批，顺序：弹窗 / 遮挡 → 日期 → 下拉 → 表格 → 帧与新标签），第一批只装真实需求里出现过的模式；`09` 其余内容为 backlog。
0.4（10-15 作者定）：追踪模式 + 线路层诊断外部工具的接法（子进程、读其 JSON 输出） + 指纹探测与分析（页面脚本读了哪些信号、谁读的、本浏览器呈现的值与参照值并排；只分析不改值）；`where`、`recon` v0 同版。账号池与代理池（10-15 作者定）：`store` 加 `proxies` 表与账号到代理的绑定，账号级 guard 预算、冷却与健康状态，分配策略固定 / 轮流 / 最久未用；`direct` 模式一账号一浏览器上下文（`Target.createBrowserContext` 的 `proxyServer`），storageState 与 Python 客户端带同一代理；健康检查只打用户指定地址，默认本机靶场回显。出口策略可配置：固定或轮换，轮换的触发条件由用户在配置里定义，默认固定且撞墙仍走 guard / handoff。
0.4 补充（10-16 作者定）：旧别名在 0.4 删除，不保留一版；`net list` / `console list` 无分页参数时默认每页 100，`--page-size 0` 为全部；`pass` / `pwd` 计入敏感名（脱敏规则 default@2）；健康检查只打用户指定地址，未指定时不检查，状态记 `unchecked`（原「默认本机回显」作废）；0.4 同版加入：内嵌状态解码器（只做 script 内 JSON、`window.__X__ =`、base64 ViewState 三种，作为 `find` / `where` 解码链的内置步骤）、帧路径 ref（`f<n>/e<m>`，`snapshot --frames` 才展开）、`recon` v0 只答四问（技术栈、数据通道清单与覆盖率、cookie 分类、防护识别；`exports/dossier.json` + `.md`；`--probe` 推 0.5）；`screenshot --annotate` 推 0.5；追踪模式记录解密后明文推 0.5；Windows 不检查文件权限（只 POSIX 查），Windows 端到端与其它平台同等验收；`finding.tool` 加 `where`。v0.3.0 的 Release 在 0.4 完成后发布，仓库在此之前保持私有。
浏览器 / 指纹参照语料（10-16 作者定）：0.5 做；全部以云端采集为准（Cursor 云 agent VM），不做真机对照；云端采集允许从 ziglang.org 下载 Zig（版本以 `native/wireprint/build.zig.zon` 为准）以跑线路层；线路层存 JA4 等归一化结果，不存原始字节；每条记录附采集环境（浏览器与版本、启动方式、Xvfb 尺寸、TZ、lang、字体列表、GPU 状态），并把 Xvfb 尺寸、TZ、lang 固定下来；Linux 上字体探测受 fontconfig 别名影响会误报【实测 10-16 云端】，结论须标注；数据存放在独立的私有 Cursor Origin 仓库 `darth-vader/tabcap-corpus`，不进本仓库；每天检查一次各浏览器稳定版，有新版才采集并开 PR，由一个 Cursor Project 执行，规则见该仓库的 `AGENTS.md`。

发布（10-15 作者定）：目标平台 mac arm64、linux x64、windows x64，三者都要有二进制和 CI；对外文案英文优先，中文并行；skill 适配 Claude Code、Hermes Agent、DeepSeek harness 三种宿主，同一仓库发布（WorkBuddy 不做，10-15 作者定）；0.3.0 发布时同步上 Claude Code 与 Hermes 的市场，标 alpha；0.5 为正式公开版，门槛清单另列。
命令命名（10-15 作者定）：命令名与参数名对齐 Chrome DevTools MCP 的工具面（Google 官方，Apache-2.0），让用过它的 agent 零适应；对齐表由调研给出、作者审过后在 0.3 打包格一次改完，旧名保留一版别名。
Skill 规范（10-15 调研）：三宿主都认 agentskills.io 的 `SKILL.md`（name 与目录同名、kebab-case；description ≤ 400 字且触发词前置；正文 < 500 行，命令表放 `references/`；`compatibility` 声明需另装 tabcap）；dsh 与 Claude Code 共用 `~/.agents/skills/`。打包格加 `skills-ref validate`。
Windows 待验项：`--remote-debugging-pipe` 在 Bun 的 `node:child_process` 下的句柄传递；`--no-startup-window` 与前台归还的替代（无 `osascript`）；守护进程监听改为命名管道或带令牌的回环 TCP（Bun.serve 的 unix 选项不支持 Windows）；`state.db` 与证据包的权限改用 ACL；CfT win64 的下载与解压（无 `unzip`）。

格 3 顺手解决三个未验点：黑洞代理是否真截断外连（`lsof`）、`--no-startup-window` / `open -g` 能否不抢前台、`CDPScreenshotNewSurface` 对隐藏标签截图是否有效。

wire 工具并入 `native/wireprint/`（10-16 作者定）：基准画像为集成的 Chrome for Testing 版本，作者个人浏览器画像不进仓；`serve` 不编译，TLS 终结由 Bun 做（0.4-W2）

## 4. 子 agent 的工作规则

- 读 `AGENTS.md`，遵守全部条款；expected 只来自规范与靶场，不为过测试改 expected。
- 规范有歧义或自相矛盾时，按最字面的读法实现，并在报告里列出歧义，由主循环裁决；不改 `docs/`，只追加 `NOTES.md`。
- 只在本目录工作；不碰本地第三方材料；不访问第三方站点；不装非必要依赖，装失败就报告。
- 提交：英文 commit message，不加任何署名或 attribution 行；每格至少一次提交。
- 报告：做了什么、测试输出原文摘要、歧义清单、文件清单、`git log --oneline`。

## 5. CLI 命名对齐表（10-15 作者定，进 0.3 打包格一次改完；旧名保留一版别名）

| 旧 | 新 / 增 |
|---|---|
| `net list --type / --limit / --offset` | `--resource-types / --page-size / --page-idx`（页码语义，`nextOffset` → `nextPageIdx`） |
| `console` | `console list`（加 `--types`，`--level` 保留）+ `console show <id>`；分页同上 |
| `press` | `press-key` |
| `type` | 保留，加 `--submit-key`，帮助写明作用于当前焦点元素 |
| `screenshot --out / --full` | `--file-path / --full-page`；新增 `--format`、`--quality`、`--ref` |
| `snapshot` | 新增 `--verbose`、`--file-path` |
| `tabs` / `tab use` | `tab list` / `tab select [--bring-to-front]`（默认不拉前台）；新增 `tab new <url> [--background]` |
| `click` / `dialog --text` / `wait --text` / `evaluate` / `reload` | 加 `--dbl-click` / 别名 `--prompt-text` / 可重复传、任一命中即返回 / 加 `--function`、`--args` / 加 `--ignore-cache` |
| 新命令 | 先 `hover`、`resize`、`upload`；`drag`、`fill-form`、`emulate` 后排 |
| 交互命令 | 加 `--snapshot`，操作后顺手带回新快照 |

不改：`navigate`、`go`、`find`、`click`、`fill`、`evaluate`、`dialog`、`wait`、`net show / body` 及全部独有命令。帮助与 SKILL.md 必须写明三处语义差异：ref 来自 `snapshot` 且文档一变即失效（不是 uid）；`net list` 默认藏失败与 `data:`，`--all` 全列；`--snapshot` 是可选的。

### 5.1 上下文预算（0.5-C，10-16 作者定：「先排一格上下文预算吧。现在做。」；数字作者以后再调）

CLI 契约的输出层（`src/cli/main.ts`，命令跑完、打印之前；经 MCP `tabcap_run` 走同一层）按这个顺序处理 `data`：

1. **输出过滤**（作者 10-16 追加：「想让 agent 少读输出、直接在命令里过滤搜索需要的信息」）：所有命令共用 `--select <path>`（点号键、`[n]`、`[*]`，路径 ≤ 256 字符、≤ 32 段；无 `[*]` 时取不到报 `not-found`）、`--grep <regex>`（≤ 256 字符、`u` 标志，坏正则报 `usage`；数组按元素的 JSON 文本筛，顶层字符串或对象里含换行 / ≥ 1000 字符的字符串字段按行筛，给 `{line, text, match}`，`--context n` ≤ 20，`--max-matches` 默认 50、≤ 1000）、`--fields a,b,c`（数组元素只留这些顶层键）。顺序 select → grep → fields；信封多 `filter: {select, grep, fields, matches, total, capped}`，用 `--select` 时还多 `selected`。CLI 在任何命令解析器之前把它们从 argv 里取走（`--` 之后不动），所以 schema 里只在顶层 `sharedFlags` 列一次，不进各命令的 `flags`；`screenshot` 不收 `--full`（0.4 把旧 `--full` 改名 `--full-page`，仍是未知选项）。打印文本的命令（`--text`、`schema --json`）带过滤参数报 `usage`。`snapshot`、`net body`、`net grep` 自带同名的 `--grep` / `--context` / `--max-matches`（命令内搜索，0.5-F），在这三条命令上通用过滤不接管这几个参数。
2. **输出预算**：`data` 序列化后超过 `TABCAP_OUTPUT_LIMIT`（默认 16384 字节；`0` 关闭）时改为 `{summary, file, bytes, truncated:true}`，文件与摘要见 `04` §24；`--full` 原样全打；`net list`、`console list`、`snapshot`、`schema` 不受此限。
3. **默认值**：`net list` / `console list` 每页 30（0.4 补充里的 100 作废；`--page-size 0` 仍是全部）；`snapshot` 与动作命令的 `--snapshot` 默认 `--max-chars 12000`（原 60000），被截时 `note` 写明 `--max-chars`、`--interactive`、`--frame`、`--file-path`；`outline` 保持 6000，被截时也带 `note`。
4. **帮助**：`tabcap --help` 是索引（每命令一行、分组同 gen:docs、摘要取第一分句截 56 字符，≤ 8 KB；0.6 加命令后从 6 KB 放宽；0.6-E 起诊断命令 `trace`、`fingerprint`、`wire` 归到最后的 `Diagnostics (optional)` 组（id `diagnostics`，排在 `Other` 之后），README 的生成表把它们单列在表尾的同名小表里，`references/commands.md` 里也是最后一节；MCP 核心集与 SKILL.md 本来就不含它们）；`tabcap help <命令>` 同 `tabcap <命令> --help`（不变），`tabcap help <组>` 打组内每条命令的完整帮助（组名为索引里的 `[id]`，或命令词如 `net`）；**0.7-C 起**改为每条命令一项：不带公共旗标（`--session` / `--timeout`）的用法行，下一行是摘要的第一分句（括号内的分号不断句，截 160 字符），选项表与示例只在 `tabcap help <命令>`（`help network` 13209 B → 2456 B【实测】）。未知命令的 `next` 不再列出全部命令（约 8 KB），只给 1–3 个最近的命令（同首词、首词互为前缀（≥3 字符）、或编辑距离 ≤ max(1, ⌊长度/4⌋)，按编辑距离排）和 `tabcap --help`（`tabcap frobnicate` 8145 B → 201 B，`tabcap trac status` 8146 B → 249 B【实测】）；`bundle` 下的未知子命令同样只在 `bundle` 组里找。`schema --json` 形式不变，只多 `sharedFlags`。
5. **skill**：`SKILL.md` ≤ 8 KB（`validate:skill` 检查），只留规则、录 → 析 → 回放、凭据、交接、输出预算一段和 10 行速查；其余按主题放 `references/`（`recording.md`、`analysis.md`、`pools.md`、`trace-and-probes.md`、`replay.md`、`mcp.md` 占位），`commands.md` 仍由 gen:docs 生成。

10-16 实测（本机 macOS arm64、CfT 155，e2e 靶场 `test/e2e/site.ts`，默认参数；token 按字节 / 3.5 估；「后」= 本格改完同一路径重跑）：

| 命令 | 场景 | 前：JSON 字节（≈token） | 后：JSON 字节（≈token） | `--text` 字节 |
|---|---|---|---|---|
| `session start` | s07 | 207 (59) | 同左 | – |
| `navigate` | s07 | 233 (67) | 同左 | – |
| `snapshot --interactive` | s07 | 446 (127) | 同左 | – |
| `fill` | s07 | 258 (74) | 同左 | – |
| `click` | s07 | 412 (118) | 同左 | – |
| `net wait` | s07 | 568 (162) | 同左 | – |
| `net list` | s07 | 1147 (328) | 1146 (327) | – |
| `net show` | s07 | 1874 (535) | 1873 (535) | – |
| `net body` | s07 (html) | 1496 (427) | 同左 | – |
| `snapshot` | s07 | 604 (173) | 同左 | – |
| `outline` | s07 | 282 (81) | 同左 | – |
| `navigate` | list (s20 noise) | 227 (65) | 同左 | – |
| `net list` | list (s20 noise) | 1859 (531) | 同左 | – |
| `net list --all` | list (s20 noise) | 15559 (4445) | 7118 (2034) | – |
| `snapshot` | list (s20 noise) | 536 (153) | 同左 | – |
| `net list` | s20 + 40 fetches | 10464 (2990) | 6841 (1955) | – |
| `snapshot` | s40 de-DE | 1087 (311) | 同左 | – |
| `where` | s40 de-DE | 465 (133) | 同左 | 250 |
| `snapshot` | s41 | 856 (245) | 同左 | – |
| `where` | s41 | 842 (241) | 同左 | – |
| `evaluate` | s41 | 121 (35) | 同左 | – |
| `screenshot` | s41 | 263 (75) | 同左 | – |
| `tab list` | popup | 403 (115) | 同左 | – |
| `snapshot` | popup | 327 (93) | 同左 | – |
| `snapshot` | s22 frames | 1750 (500) | 同左 | – |
| `snapshot --frames` | s22 frames | 3122 (892) | 同左 | – |
| `outline` | s22 frames | 1876 (536) | 同左 | – |
| `trace list` | all pages | 259 (74) | 同左 | 84 |
| `recon` | all pages | 770 (220) | 同左 | 4620 |
| `handoff status` | - | 92 (26) | 同左 | – |
| `fingerprint probe` | - | 5734 (1638) | 同左 | 4626 |
| `analyze find` | bundle 1 | 1991 (569) | 同左 | 931 |
| `analyze diff` | bundle 1+2 | 43957 (12559) | 289 (83) 摘要+文件 | 26125 |
| `analyze deps` | bundle 1 | 169451 (48415) | 1725 (493) 摘要+文件 | 35366 |
| `analyze chain` | bundle 1 | 729 (208) | 同左 | 375 |
| `wire probe` | s40 client | 8711 (2489) | 同左 | 3472 |
| `tabcap --help` | - | – | – | 21716 → 6066（索引） |
| `schema --json`（只给机器） | - | – | – | 140102 → 142148（加 `sharedFlags`） |
| `skills/tabcap/SKILL.md`（触发时整份载入） | - | – | – | 29649 → 7507 |

「list 页」取 s20 noise 页（60 个端口扫描失败请求 + 10 张 `data:` 图，默认被藏，所以默认 `net list` 本来就小）；「+ 40 fetches」是在同页用 `evaluate` 再发 40 个 `/api/look`，让默认可见行数超过 30。`--text` 输出不算 `data`，不受预算限制（`analyze deps --text` 35 KB、`analyze diff --text` 26 KB 照旧）。

0.5-F 增（tabcap 独有，Chrome DevTools MCP 没有对应名字，按上表的拼写习惯取名）：`snapshot --grep <regex> / --css <selector> / --xpath <expr> / --ref <e12> --depth <n>`（带 `--context`、`--max-matches`）；新命令 `html <ref|--css selector> [--inner|--text|--attrs] [--max-chars]`；`net body` 加 `--grep`、`--lines a-b`、`--at line:col`、`--url`、`--pretty`、`--context`、`--max-matches`（id 改为可省，与 `--url` 二选一）；新命令 `net grep <regex> [--resource-types] [--max-matches] [--context] [--pretty]`。完整契约以 `tabcap schema --json` 为准。
