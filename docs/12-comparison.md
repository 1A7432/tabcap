# 与「录制流量 → API 客户端」类工具的对照

2026-10-16。格 0.6-K。本文对照 tabcap 0.5.0 与把录到的浏览器流量变成 agent 可调用接口的几类工具：Integuru、agent-browser 的 derive-client skill、Unbrowse，回放层（Playwright `routeFromHAR`、VCR.py），解码层（Burp 插件 PyCript）。只写各自**做什么、不做什么**，不评价。

标注：【实测】本格在本机靶场跑过，输出在 `docs/compare/`；【推断】从引文或输出推出；【待验】没跑、没找到来源。

## 1. 规则

- 关于别家产品的每一句话，要么引自它自己的公开文档 / README（§2，带链接与读取日期），要么是本格在 tabcap 本地靶场上复现的结果（§4，命令与输出原样记录）。两者都没有的标【待验】，不进 README 的表。
- 表里的「–」只表示「按 2026-10-16 读到的公开文档，没有描述这项」，不是「它做不到」。
- 网页来源经 WebFetch 抽取，引文逐字程度【待验】（抽取模型限制单条引文长度，长句被拆成两段）；derive-client 的引文逐字取自本机安装的 agent-browser 0.39.0 自带文件。
- 行业中性：靶场页面只模拟「带自定义正文加密的企业后台」「老式 frameset + iframe 弹层」两种形态，不指任何具体行业。

## 2. 来源（读取日期均为 2026-10-16）

**Integuru** — https://github.com/Integuru-AI/Integuru （README，main 分支 `README.md`；侧栏许可证）

| ID | 引文 |
|---|---|
| I1 | "The agent outputs runnable Python code that hits the platform's internal endpoints to perform the desired action." |
| I2 | "It identifies parts of the request that depend on other requests." |
| I3 | "It also attaches these requests to the original request to build out a dependency graph." |
| I4 | "This process repeats until the request being checked depends on no other request" / "and only requires the authentication cookies." |
| I5 | "Recommended to use gpt-4o as the model for graph generation as it supports function calling." |
| I6 | "add the `OPENAI_API_KEY` environment variable" |
| I7 | `poetry run python create_har.py` 之后："Log into your platform and perform the desired action (such as downloading a utility bill)." |
| I8 | "Ensure that you complete the 2FA process and obtain the cookies/auth tokens/session tokens after 2FA." |
| I9 | 选项：`--prompt`（必填）、`--model`、`--har-path`（默认 `./network_requests.har`）、`--cookie-path`（默认 `./cookies.json`）、`--max_steps`、`--input_variables`、`--generate-code`；用法 `poetry run integuru --prompt "download utility bills" --model <gpt-4o\|o3-mini\|o1\|o1-mini>` |
| I10 | "The newest version of Integuru is available at www.integuru.com"；侧栏许可证 AGPL-3.0 |

**derive-client** — agent-browser 0.39.0 自带 `skill-data/derive-client/SKILL.md`（Homebrew 安装；`agent-browser skills get derive-client` 同文）；main 分支同名文件 https://github.com/vercel-labs/agent-browser/blob/main/skill-data/derive-client/SKILL.md 标题一致。agent-browser README 同版本，许可证 Apache-2.0。

| ID | 引文 |
|---|---|
| A1 | "recording browser traffic into a HAR file, then generate a standalone client or CLI that calls the endpoints directly, with no browser needed after the first recording" |
| A2 | "agent-browser embeds text response bodies (JSON/HTML/JS) in the HAR by default" |
| A3 | "If the site needs login, log in **before** starting the HAR so credentials don't land in the recording unnecessarily." |
| A4 | "**Auth**: compare request headers across endpoints. … Replay only the ones that matter — test by omission in step 5." |
| A5 | "Call every generated function against the live API and compare the response shape with the recording." |
| A6 | 排错表："Works then breaks \| Signed/expiring request params \| Fall back to the browser for that step; derive the rest" |
| A7 | "keep the HAR so the client can be re-derived." |
| A8 | "Respect the site's terms of service and rate limits; add delays for bulk fetching." |
| A9 | 头部 `allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)`；`agent-browser --help`："Start here (for AI agents)" —— 这是给 agent 读的步骤，解析由 agent 完成 |
| A10 | README："`agent-browser mcp` # Start an MCP stdio server"；"`agent-browser frame <sel>` # Switch to iframe" |

**Unbrowse**（只有厂商材料）— https://www.unbrowse.ai/ 、https://unbrowse.ai/docs 、https://github.com/unbrowse-ai/unbrowse （README；侧栏许可证）

| ID | 引文 |
|---|---|
| U1 | docs："Unbrowse is a remote MCP server: agents call it, and it signs in to sites for them in its own cloud browser." |
| U2 | docs："compile HAR files or recorded traces into a one-call `learned.*` capability." |
| U3 | docs："proves each with a browserless replay and adds them to your tools." |
| U4 | docs："each tool carries its input schema and an output schema learned from verified responses." |
| U5 | 首页："Unbrowse watches the site's own first-party requests" |
| U6 | 首页："You may still need to complete a sign-in or verification step yourself."；账号复用选项 "Allow · Ask · Never" |
| U7 | 首页："Unbrowse is free during beta, with 500 verified calls a month." |
| U8 | README："This is the open-source client for the hosted Unbrowse service"；"`unbrowse mcp` runs a local stdio proxy to the hosted MCP"；侧栏许可证 MIT |

**回放层**

| ID | 来源 | 引文 |
|---|---|---|
| P1 | https://playwright.dev/docs/mock （Mocking with HAR files） | "HAR replay matches URL and HTTP method strictly. For POST requests, it also matches POST payloads strictly." |
| P2 | 同上 | "Setting `update` option to true will create or update the HAR file with the actual network information." |
| P3 | https://playwright.dev/docs/api/class-browsercontext#browser-context-route-from-har | `notFound`："If set to 'abort' any request not found in the HAR file will be aborted."；"Playwright will not serve requests intercepted by Service Worker from the HAR file." |
| V1 | https://vcrpy.readthedocs.io/en/latest/ | "records all HTTP interactions that take place through the libraries it supports."；"This flat file is called a cassette." |
| V2 | 同上 | "intercept any HTTP requests that it recognizes from the original test run." |

**解码层**

| ID | 来源 | 引文 |
|---|---|---|
| C1 | https://github.com/Anof-cyber/PyCript （仓库描述） | "Burp Suite extension to decrypt/encrypt any encrypted traffic (AES/RSA/Encodings and more) with custom code in any language." |
| C2 | 同上 README | "enables users to encrypt and decrypt HTTP requests, responses, and WebSocket messages."；许可证 MIT |

## 3. 对照表

每格后的方括号是依据：引文 ID、`run` = §4 靶场复现、`tabcap` = 本仓库的命令表 / README。

| 能力 | tabcap 0.5.0 | Integuru | derive-client | Unbrowse | HAR 回放（Playwright `routeFromHAR`、VCR.py） |
|---|---|---|---|---|---|
| 录下浏览器会话 | ✓ 证据包，可导出 HAR、可导入 HAR [run] | ✓ `create_har.py` 开浏览器，人登录并操作 [I7] | ✓ `network har start/stop` [A1, run] | ✓ 自己的云浏览器，或上传 HAR [U1, U2] | ✓ Playwright `update: true` [P2]；VCR.py 录它支持的 HTTP 库，不是浏览器 [V1] |
| 请求输入追到来源 | ✓ 确定性，只认精确匹配；算不出的标 `computed-in-page` [run] | LLM 推断（gpt-4o 生成依赖图）[I2–I5] | LLM 推断（agent 读 HAR、按省略法试）[A4, A9] | – | – |
| 生成新客户端 | ✓ httpx（`replay export-python`）[tabcap] | ✓ Python [I1] | ✓ 脚本 / CLI / 库 [A1] | 编译成托管的 MCP 工具 [U1, U4] | – |
| 给已有代码喂录到的响应（fixture） | ✓ `replay serve`，任何 HTTP 客户端可连 [tabcap] | – | – | – | ✓ 在测试进程里 [P1, V2] |
| 对服务端逐字段回放比对 | ✓ `replay check`，s21、s22 共 12 条全 same [run] | – | 由 agent 调真实接口比对响应形状 [A5] | ✓ 托管侧 browserless replay 验证 [U3] | – |
| 多层 / 跨源 iframe | ✓ 帧路径 ref，深 3 层的跨源帧里 fill、click、where [run] | – | 部分：同源帧展开，跨源帧要 `frame` 切入；录到的 HAR 缺第 3 层帧文档、跨源帧文档无正文 [run] | – | – |
| 加密正文 | 标出（熵 + 解码链路径）[run]；明文靠用户写的 decode 插件：s21 装上示例插件后 `find` / `where` 命中、`net body --decoded` 看到明文 [run] | – | – （HAR 里只有密文 [run]；签名参数「回到浏览器」[A6]） | – | – |
| 登录 / 验证交给人 | ✓ 每站每会话只试一次登录，验证页进 `waiting` [tabcap] | 录制前由人完成 2FA [I8] | 录制前由人登录 [A3] | ✓ 一次性链接，人在 unbrowse.ai 完成 [U6] | – |
| 线上请求按站点限速、计数 | ✓ `replay check --live` 按站点计数、默认 0.5 次/秒 [tabcap] | – | 文字建议加延迟 [A8] | – | – |
| MCP | ✓ `tabcap mcp`（暴露 tabcap 自己的命令）[tabcap] | – | ✓ agent-browser 的 `mcp` [A10] | ✓ 托管 MCP，本地 stdio 代理 [U1, U8] | – |
| 在哪跑 | 本机 | 本机 + OpenAI API [I6] | 本机 | 托管 [U8] | 本机 |
| 许可证 | Apache-2.0 | AGPL-3.0 [I10] | Apache-2.0 | 客户端 MIT [U8] | — |

解码层不在表内：PyCript 是 Burp 插件，用户用任意语言写加解密逻辑，作用于请求、响应和 WebSocket 消息 [C1, C2]；它与 tabcap 的 decode 插件是同一层思路（用户自带解密），tabcap 不带任何站点的解密实现。

## 4. 靶场复现（【实测】2026-10-16，macOS arm64，Chrome for Testing 155.0.8059.79）

靶场：`bun docs/compare/range.ts`（`S21_PORT=47621` 固定 s21 端口；s22 两个源端口随机）。s22 是 `test/e2e/site.ts` 的 `startFrameSite` 原样；s21 在 `site.ts` 里还没有，`range.ts` 按 docs/05 §s21 的描述实现：`/api/key` 明文给密钥，`/api/secret` 返回 `{code:0, data:"<base64 AES-GCM 密文>"}`，页面解密后渲染 12 行，`/api/secret` 带 `x-ts` / `x-sign` 请求头；密钥与 IV 是靶场字面量，每次返回同样字节。

### 4.1 tabcap

每个场景一个临时 `TABCAP_HOME`，`browser start --proxy none --executable-path <Chrome for Testing>`。

- s21（`docs/compare/tabcap-s21.txt`）：`net start` → `navigate /s21` → `wait --text S21-0001` → `net wait --url /api/secret` → `snapshot` → `where S21-0001` → `net stop`；离线 `analyze find <b> S21-0001 --text`、`analyze deps <b> --text`、`replay check <b> --against http://127.0.0.1:47621`。
  - `where`：`no-match`。`find`：0 命中，`suspect r-11 GET …/api/secret 474 B entropy 7.56 decode [base64] $.data`，提示「the page probably decrypts them in JS (consider trace mode)」。
  - `deps`：`header x-ts timestamp`，`header x-sign computed-in-page [looks-signature]`；`--write-findings` 写入的 finding 分级为 `推断`。
  - `replay check`：4 条全 same。
  - 早一次只有 2 行时密文 80 B，低于 `find` 判熵的下限 256 B（`ENTROPY_MIN_SIZE`），输出「Nothing looks encrypted or missing」——短密文不会被标出，这是 tabcap 的已知边界，原样留在同一文件末尾。
- s21 + decode 插件（`docs/compare/tabcap-s21-decode.txt`，【实测】2026-10-16，同一靶场、同一守护进程）：`docs/compare/plugins/s21-aes-gcm/`（`manifest.json` + `decode.ts` + `config.json` 的 Bun 插件；用 WebCrypto `crypto.subtle` 的 AES-GCM 解 `/api/secret` 的响应正文；密钥与 IV 是本地靶场字面量，不是任何站点的解法）。先不装插件录一个包 A，再把插件拷进 `$TABCAP_HOME/config/plugins/`、`tabcap plugin enable s21-aes-gcm`，再录包 B。
  - `net body r-10 --decoded`（包 B）：`view: "decoded"`，`by: s21-aes-gcm`，458 B，预览 `{"rows":[{"no":"S21-0001","amount":"1234.50"},…`。
  - `where S21-0001`（会话 b21，插件生效）：命中 `r-10 $.rows[0].no`，`match: exact`，解码链 `["plugin:s21-aes-gcm"]`；无插件时同一问题是 `no-match`（上一条 s21）。`where` 只读会话自己的录制，没有对包路径的形式，所以只在录制会话里跑。
  - `analyze find <包 B> S21-0001 --text`：1 命中，`decode [plugin:s21-aes-gcm] exact $.rows[0].no`，`decoders: plugin:s21-aes-gcm=1`。
  - 离线补解：对无插件录的包 A，`find` 先是 0 命中加 `suspect`（同上）；`bundle decode <包 A>` 解出 1 条（`decoded: 1, failed: 0, appended: 1`），`events.jsonl` 不变，写入 `decoded.jsonl`；再 `find` 同样 1 命中；`bundle info` 报 `decodedSidecar: true`。
- s22（`docs/compare/tabcap-s22.txt`）：docs/05 §s22 的走法。
  - 默认 `snapshot` 只有帧头（5 个帧，`f2/f1/f1` 深 3 层）；`snapshot --frames` 给出 `f1/e6`（栏目一）、`f2/f1/e13`（关键词）、`f2/f1/e14`（查询）、`f2/f1/f1/e21`（S22-0002）等 ref。
  - `fill f2/f1/e13 abc` + `click f2/f1/e14`：录到 `r-28 GET http://localhost:…/s22/search?q=abc`，动作帧 `f2/f1`。
  - `where f2/f1/f1/e21`：`r-13`（`/s22/table`），selector `table > tr:nth-of-type(2) > td:nth-of-type(1)`。
  - 遮挡头给出 `close f2/f2/e4 "×"`，点击后 `overlays  none`。
  - 证据包 8 条请求，含 `/s22/table`；`replay check` 按两个源各跑一次，8 条全 same。
  - `deps`：`query q constant 1 sample(s) [single-sample]`——没有把 `q=abc` 归到录到的 `fill`，【待验】是帧内 fill 未关联还是单样本时的设计，留给后续格。

### 4.2 agent-browser 录制 + derive-client 第 2、3 步

agent-browser 0.39.0（本机已装）。为不碰作者自己的 agent-browser 配置（它指向 9222 端口的浏览器），用单独的配置文件（只设 `executablePath` 为同一个 Chrome for Testing）和 `--namespace tabcap-k06 --session k06`；进程表确认它自己起了一个 `--remote-debugging-port=0`、临时 user-data-dir 的 Chrome。derive-client 的第 2、3 步是确定性的 `jq`，原样在 `docs/compare/derive-steps.sh`；第 4、5 步（写客户端、对真实接口验证）由 agent 做，不在本格复现。

- s21（`docs/compare/agent-browser-s21.txt`、`agent-browser-s21.har`）：`network har start` → `open /s21` → `wait --text S21-0012` → `network har stop`。HAR 4 条；第 2 步列出 `/api/key`、`/api/secret`；第 3 步看得到 `x-sign`、`x-ts` 请求头和 `data` 密文；HAR 里找 `S21-0001` 为 0。
- s22（`docs/compare/agent-browser-s22.txt`、`agent-browser-s22.har`）：
  - `snapshot` 展开了同源帧（菜单链接、主区域标题），两个跨源 iframe 只显示 `Iframe [ref=e7]` / `[ref=e8]`；`frame @e7` 之后 `snapshot` 出现表单，`fill @e11 abc`、`click @e10` 生效，页面出现「找到 1 条：abc」。
  - 在表单帧里 `frame @e9` →「Ref does not point to an iframe element」，`frame '#table'` →「Could not find frame for selector」；`wait --text S22-0002` 25 s 超时。
  - HAR 7 条：没有 `/s22/table`；`/s22/form`、`/s22/modal` 的 `content.text` 为 `null`；`/s22/search?q=abc` 有正文。原因【待验】（只记录这一次运行的现象，不推断其实现）。
  - 第一次尝试在配置里加了 `allowedDomains: ["127.0.0.1","localhost"]`：s21 正常，s22 的 `open` 报「Failed to install browser network controls: CDP error (Runtime.evaluate): Cannot find default execution context」。上表用的是默认设置那一次，两次都留在文件里。
- tabcap 读 agent-browser 的 HAR（`docs/compare/tabcap-reads-agent-browser-har.txt`）：`bundle import har` 后 `analyze find` 对 s21 给出同一个 suspect（474 B，熵 7.56），`deps` 分类同上；s22 的 HAR 导入后 `find S22-0002` 0 命中，提示 2 条请求无正文。

### 4.3 【待验】行

- **Integuru**：本机环境没有 `OPENAI_API_KEY`，未运行。作者可在本机跑（会把 HAR 内容发给 OpenAI API；靶场数据，无凭据）：
  ```sh
  git clone https://github.com/Integuru-AI/Integuru && cd Integuru && poetry install
  export OPENAI_API_KEY=…            # 作者自己的
  bun <tabcap 仓库>/docs/compare/range.ts &   # 记下 s21 / s22 的地址
  poetry run python create_har.py    # 在它开的浏览器里打开 s21，等表格出现后关闭（I7）
  poetry run integuru --prompt "fetch the order rows" --model gpt-4o --generate-code
  ```
  要看的：依赖图是否把 `/api/secret` 连到 `/api/key`、`x-sign` 怎么处理、生成的代码能否拿到明文行；s22 同样走一遍，看跨源帧里的 `/s22/search` 是否进了 HAR。
- **Unbrowse**：未运行。靶场只监听 127.0.0.1，托管的云浏览器连不到；`unbrowse learn` 上传 HAR 会把数据发到托管服务，是否做由作者定。
- **Playwright `routeFromHAR` / VCR.py**：只引文档，未在本机跑（不联网装依赖）。
- **derive-client 第 4、5 步**：要一个 agent 按 skill 写客户端并调真实接口，未做。
- ~~tabcap decode 插件~~：已跑，见 §4.1「s21 + decode 插件」。

## 5. tabcap 不做的事

- 不做 LLM 推断：`deps` 只认精确匹配，算不出的标 `computed-in-page`，不猜。
- 不提供云浏览器，也没有预先索引好的站点库：浏览器是本机的 Chrome for Testing 或作者自己的 Chrome。
- 不带验证码或挑战的解法；验证页交给人。
- 不复现签名类参数和加密正文：生成的客户端把它们标成 TODO，这些请求留在真实浏览器会话里；不带任何站点的解密实现（明文视图靠用户自己写的 decode 插件）。
- 不把站点接口编译成 MCP 工具：`tabcap mcp` 暴露的是 tabcap 自己的命令。

## 6. 找不到来源、没写进表的说法

- Unbrowse 截获的是 XHR / fetch（文档只写「watches the site's own first-party requests」）、它怎么抽取接口与鉴权、是否用 LLM。
- Integuru 对 iframe、加密正文、账号节奏的处理（README 未提）；integuru.com 托管版的能力。
- Playwright `routeFromHAR` 对跨源 iframe 的录制与回放细节；VCR.py 的默认匹配字段（首页未写，在「Request matching」子页，未读）。
- agent-browser 的 HAR 为什么缺第 3 层帧文档与跨源帧正文（只记现象）。
- AES Killer 的 README 未读，只用 PyCript 代表解码层。
