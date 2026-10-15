# 背景与方案：把扩展式浏览器桥和 agent-browser 的长处合起来

2026-10-15 讨论记录。

> **后续（同日）**：目标已从「给 agent-browser 做中继」改为「自用、开源的采集与协议分析工具」，定位与路线以 `03-product-thesis-and-roadmap.md` 为准。本文 §5 的推荐相应调整为：主入口用自己的命令行，中继兼容标准 CDP 只作附带能力；§6 的待定决策并入 `03` §8。

标注：【实测】本机跑过；【推断】间接推出；【待验】没条件验证。

## 1. 用途

让 AI 驱动**自己那台已登录的 Chrome**：录网站接口回包做离线回放 fixture、看一个接口的完整请求参数与响应、在页面里跑 JS。

## 2. 两边的长处和痛点

| | Kimi WebBridge | agent-browser |
|---|---|---|
| 连接 | 扩展挂 `chrome.debugger`，装一次不再弹框 | 远程调试端口；每条新连接弹「要允许远程调试吗」【实测】 |
| 焦点 | 焦点模拟，后台标签干活 | `tab new`、切标签把 Chrome 拉到前台【实测】 |
| 会话隔离 | session = 标签组 | session / `--pin-tab` |
| 抓网络 | start/list/detail；正文懒取，stop 或跳转后丢 | 随时有记录、`--json` 详情完整、HAR、route 改包；跳转后响应体可能为空，要开 `har start --content all` 兜底【实测】 |
| 注入与调试 | 有 `cdp` 原始透传【实测】，其余没有 | init-script、trace、profiler、录屏、console、React 树 |
| 调用 | curl 发 JSON | CLI、batch、MCP |
| 来源 | 闭源、无许可证 | Apache-2.0 开源 |

agent-browser 另一个坑：`eval` 里 `.click()` 打开 `target=_blank` 会被拦（不是用户手势），要取 href 自己开。这是用法问题，和走哪条连接无关。

痛点的根源：agent-browser 走 Chrome 远程调试端口（弹框）并调用 `Target.activateTarget`（抢焦点）；扩展方案走 `chrome.debugger`，并且刻意拒绝激活标签。

## 3. 合起来的架构

```
agent-browser 原版（命令、快照、HAR 全保留）
   │ --cdp ws://127.0.0.1:PORT
本地中继（对外伪装成标准 CDP；浏览器级命令在本地应答；把 activateTarget 换成焦点模拟；顺手录包落盘）
   │ WebSocket 或 native messaging
自写 MV3 扩展（chrome.debugger 按标签挂，标签组隔离会话）
```

## 4. 已有同类项目

- **[agent-browser-stealth 分叉](https://gitea.oimcloud.myaddr.tools/oimwiodev/chrome-use/src/tag/v0.27.0-fork.32/README.md)**：正是上面这套。agent-browser 命令兼容，扩展走 native messaging，不弹授权框，Apache-2.0。它踩过的坑可以当清单：`Browser.getVersion` 转给扩展会失败，导致每条命令都重连（[提交](https://gitea.oimcloud.myaddr.tools/oimwiodev/chrome-use/src/commit/bb41c24c0856e886f2746360a2e67c5a785d8ee5)）；多个 agent 共用中继时回包串线（[提交](https://gitea.oimcloud.myaddr.tools/oimwiodev/chrome-use/src/commit/a6631cd7d898b52b74f76602c42ef9e8662e1c13)）。缺点：个人维护、基于 0.27（上游已 0.39）、带反检测改动（会改页面指纹）、要装第三方扩展和本地组件。
- **[Playwright MCP Bridge](https://playwright.dev/mcp/configuration/browser-extension)**：微软官方，中继经 `chrome.debugger` 转发 CDP（镜像源码 [cdpRelay.ts](https://glama.ai/mcp/servers/@maywzh/playwright-mcp/blob/4890b9d509ede4dd662b7f0c4f3718cec207081e/src/extension/cdpRelay.ts)，Apache-2.0，写中继时可以照着抄）。MCP 形态，不是 agent-browser CLI。
- **[Playwriter](https://dev.co/ai/mcp/playwriter)**：扩展 + Playwright API，中继在 `localhost:19988`，只控制点过扩展图标的标签。
- **[mcp-chrome](https://www.typingmind.com/mcp/chrome-mcp)**：扩展形态的 MCP 服务，MIT。

## 5. 方案

| 方案 | 做什么 | 代价 | 能解决什么 |
|---|---|---|---|
| D 只改配置 | 工程 Chrome 用单独的配置目录、带 `--remote-debugging-port` 启动（Chrome 136+ 要求非默认配置目录） | 10 分钟，要重新登录一次 | 弹框一定没了；抢焦点大概率还在，因为 activateTarget 照样会把那个窗口拉到前台【推断】 |
| A 用现成分叉 | 装 agent-browser-stealth | 半天，主要是审代码 | 弹框、焦点都能解决；代价是依赖个人分叉、版本落后、带指纹改动 |
| **B 薄层自建（推荐）** | 自写扩展 + 中继，agent-browser 原版不动 | MVP 2–4 天【推断】 | 弹框、焦点都解决，无埋点，跟上游升级不冲突，还能顺手做录包器 |
| C 全部自建 | 自己的扩展 + 自己的 CLI | 几周 | 等于重写 agent-browser，不划算 |

**为什么推荐 B：** 中继看得到全部 CDP 事件，可以在请求完成（`loadingFinished`）时立刻取响应体和响应头落成 JSONL 或 HAR，「跳转后正文没了」从根上消失。通用自动化交给 agent-browser，只造它没有、而录 fixture 天天要用的那块。

**B 的主要风险：** agent-browser 依赖哪些浏览器级 CDP 命令（`Target.*`、`Browser.*`、flatten 会话的 sessionId 映射），中继就要在本地模拟多少，这决定是 2 天还是 2 周。`chrome.debugger` 只能按标签发命令，进不了 `chrome://` 和别的扩展页面。

**第 0 步：** 在 agent-browser 和 Chrome 之间挂一个只记日志的 CDP 代理，跑一遍常用命令（开标签、快照、点击、抓请求、录 HAR），拿到命令清单再定工作量。这一步会新建一条调试连接，要在 Chrome 里点一次「允许」。

## 6. 待定决策

1. 目标是「不弹框、不抢焦点」（D 或 A 够），还是「录包做 fixture 更顺」（才值得 B）？
2. 能不能接受往工程 Chrome 里装第三方扩展和本地组件（决定 A 在不在候选里）？
3. 选 B 的话，先做第 0 步。
4. 本 lab 的 AI 分工：wireprint 根目录 `AGENTS.md` 是「学习优先、AI 不写核心逻辑、不对第三方站点做测试」。这个工具要不要沿用，还是在本目录另写一份？
