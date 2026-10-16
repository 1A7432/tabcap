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

发布（10-15 作者定）：目标平台 mac arm64、linux x64、windows x64，三者都要有二进制和 CI；对外文案英文优先，中文并行；skill 适配 Claude Code、Hermes Agent、DeepSeek harness 三种宿主，同一仓库发布（WorkBuddy 不做，10-15 作者定）；0.3.0 发布时同步上 Claude Code 与 Hermes 的市场，标 alpha；0.5 为正式公开版，门槛清单另列。
命令命名（10-15 作者定）：命令名与参数名对齐 Chrome DevTools MCP 的工具面（Google 官方，Apache-2.0），让用过它的 agent 零适应；对齐表由调研给出、作者审过后在 0.3 打包格一次改完，旧名保留一版别名。
Skill 规范（10-15 调研）：三宿主都认 agentskills.io 的 `SKILL.md`（name 与目录同名、kebab-case；description ≤ 400 字且触发词前置；正文 < 500 行，命令表放 `references/`；`compatibility` 声明需另装 tabcap）；dsh 与 Claude Code 共用 `~/.agents/skills/`。打包格加 `skills-ref validate`。
Windows 待验项：`--remote-debugging-pipe` 在 Bun 的 `node:child_process` 下的句柄传递；`--no-startup-window` 与前台归还的替代（无 `osascript`）；守护进程监听改为命名管道或带令牌的回环 TCP（Bun.serve 的 unix 选项不支持 Windows）；`state.db` 与证据包的权限改用 ACL；CfT win64 的下载与解压（无 `unzip`）。

格 3 顺手解决三个未验点：黑洞代理是否真截断外连（`lsof`）、`--no-startup-window` / `open -g` 能否不抢前台、`CDPScreenshotNewSurface` 对隐藏标签截图是否有效。

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
