# 更新记录

[English](CHANGELOG.md) | 中文

## 未发布

### npm 由 CI 发布

- `release.yml` 多一个 `npm` job：推 `v*` tag 后用编好的二进制组装五个 npm 包并按顺序发布（先平台包后 `tabcap`），已在 registry 上的版本跳过；认证用仓库 secret `NPM_TOKEN`，没有就走 npm trusted publishing（OIDC）；`workflow_dispatch` 勾 `npm_dry_run` 可以干跑到 `npm publish --dry-run`。GitHub Release 仍是草稿。

## 0.7.0（2026-10-17）

第一个公开版本。下面的 0.6.0 打过包、测过，但没有发布；它的全部内容随本版本一起发。

### 上手验收后的发布前修正（0.7-E）

邻近项目的 agent 只看 SKILL.md 和 `tabcap guide`，在一个真实站点和一个本地复刻上跑完五条配方。结论是「可以发布」，另外指出两处会卡住新人、几处小问题：

- **录制中启用的解码插件立即生效**：录制器每个正文都重读已启用的解码插件，`plugin enable` / `plugin disable` 从下一个正文起生效；启用之前录下的正文没有视图（`net stop` 后用 `bundle decode` 补）。`status` 列出这份录制到目前为止用过的插件，`decode-plugin-outranks-page` 冲突不再要求 `net stop` + `net start`。`encrypted-site` 配方改为 `plugin init` → `plugin enable` → `net start` → 打开页面 → `net body`。
- **`replay export-python --request r-N`**：指定链的目标，与 `analyze chain --request` 同义。不给时目标是开始最晚的有数据请求，在真实页面上常是统计调用。`offline-replay` 配方写上了这个旗标。
- **`verify` 从答复里取链上推得出的输入**：链能追到上一步答复的输入，都从那份答复里取，名字敏感的也一样（`x-csrf-token`、`Authorization`）。取值方式有三种：按 JSON 路径取（字符串里的 JSON 也行），按录到的值前后文本取（如 HTML `<meta>` 里的令牌），或者在值来自解码插件明文时，用本机装着的插件解这份答复再取。只有 `verify` 复现不了的输入才要 `TABCAP_SECRET_*`，`verify_expected.json` 的 `underived` 写明原因。
- **分析启发式**：没有值的 query 键（`?queryList&id=1`）算端点的一部分，不再是参数，生成的客户端照录到的原样发送。字母短前缀加一长串数字的业务编号不再算 `looks-signature`。
- **`replay check --text`**：默认回 JSON 信封，与其它分析命令一致；`--text` 每条不是 `same` 的请求打一行，最后打合计。`--json` 去掉。
- **`fetch`**（以及 `POST /fetch`）的耗时字段改名 `timing.totalMs`（原 `timing.ms`）。
- **`analyze chain --text` 的步骤 URL 把敏感 query 参数打码**（JSON 仍是录到的 URL）。脱敏规则仍是 `default@2`：这一轮曾把 `ticket` 加进敏感名单，当天去掉——这张名单同时决定 export-python 把哪些输入当 secret，CAS 回跳 URL 里的票据对回放是录制时的常量。
- **等人的会话**：撞上挑战的那条命令、`handoff status` 和 `status` 都会等正在拍的截图（最多 5 s），不再在约半秒内答 `screenshot: null`。`status` 的每个会话多出标签的 `url`，`handoff` 每条多出交接时的 URL，回答顶层多出 `next`：人做完后执行 `tabcap handoff continue --session <名字>`，没有等人的会话时取第一条冲突的 `next`。`--text` 显示 `WAITING <原因> at <url>`，最后一行是 `next:`。

### 任务配方（0.7-A）

- **`tabcap guide [<id>]`**：按任务给入口。不带 id 列出配方（id、标题、何时用）；带 id 给出按顺序的命令（5–10 步、可直接粘贴、带 `--session`，每步写为什么）、容易漏的坑（含隐式状态）和该读的参考；`--text` 打成带 `# why` 注释的编号 shell 块。首批五条：`first-look`、`scrape-through-browser`、`encrypted-site`、`offline-replay`、`login-with-challenge`。这条命令在 `tabcap --help` 顶部新开 **Start here** 组。
- 唯一真源在二进制里（`src/cli/guides.ts`）：`bun run gen:docs` 同时生成 `skills/tabcap/references/guides.md`；单测用命令注册表解析配方里的每条 `tabcap …`，配方写了不存在的命令或旗标就失败。
- **MCP**：`tabcap_help` 多一个可选参数 `guide`（`""` 列出配方，id 给一条）；核心工具集的 instructions 指向它。
- **SKILL.md 按任务重组**：「Record → analyse → replay」一节换成五个短任务，各以 `tabcap guide <id>` 收尾；Chrome DevTools MCP 的三处差异移到 `references/devtools-mcp.md`（SKILL.md 留一行指引）。SKILL.md 仍在 8 KB 以内（8163 字节）。

### tabcap status（0.7-B）

- **`tabcap status [--text]`**：原先散在 `daemon status`、`session list`、`trace status`、`plugin list`、`handoff status` 和 guard 输出里的状态，一个回答看全。`daemon`（pid、监听方式）、`browser`（是否在跑、pid、模式、标签数）、`sessions[]`（站点、账号名、标签数与当前标签、`recording` 的包路径 / 开始时间 / 条数 / 它用的解码插件、`state` running | waiting 及原因与截图、`trace` off | on | paused 及 `decode` 与 `weakRows`、落在它身上的 fetch 停手）、已启用的 `plugins`（decode / challenge）、`handoff`（在等人的会话与原因）和 `conflicts[]`。只读、全局：不在任何录制里开命令窗口，会话在等人时也照答；守护进程没在跑也回答（`daemon.running: false`）。
- **`conflicts`**：规则对上述回答生成的句子，每条带 `code` 和 `next` 命令：会话在等人、同时该站点的 fetch 被停（`guard resume` 解不开等待，`handoff continue` 才行）；会话用 `trace start --decode` 观察页面时有解码插件生效（插件视图压过 page 视图；`plugin disable`，开着的录制从下一个正文起照办）；会话的当前标签在库内站点上、却没绑该站点（`fill --secret` 会被拒；只浏览库外页面的会话不报；先 `session stop`，再 `session start --site`）；录制还开着但浏览器或标签没了；trace 开着却没录制（`net start` 之前什么行都进不了包）。
- `--text` 打一屏：每个会话一行，然后是冲突及其 `next`。
- MCP：`tabcap_status` 进默认核心集，替下 `tabcap_handoff_status`（仍可经 `tabcap_run` 调）；核心集仍是 24 个工具。

### 渐进披露与输出契约（0.7-C）

- **未知命令**：`next` 只给 1–3 个最近的命令（同首词、互为前缀或编辑距离小）并指向 `tabcap --help` 看分组，不再列出全部命令。`tabcap frobnicate` 回答 201 字节（原 8145），`tabcap trac status` 249 字节、带 `Did you mean: tabcap trace status | …`（原 8146）。`bundle` 下的未知子命令只在 `bundle` 组里找。
- **`tabcap help <组>`**：每条命令一项——不带 `--session` / `--timeout` 的用法行，下一行是摘要的第一分句；选项表与示例只在 `tabcap help <命令>`。`tabcap help network` 2456 字节（原 13209）。`--help` 索引不变。
- **紧凑的 `decode` 块**（`trace start --decode`、`trace status`、`trace stop`）：`{on, weakRows, rows:{strong, weak, unattributed}, pending, dropped}`；`trace status` / `trace stop` 加 `--verbose` 才给背后的计数器（按原因的 `drops`、`armed`、`held`、`settling`、`evidenceHits`、`recovered`、`walks`、`sinks`、`unattributedKept`、`rows.attributed`）。`trace stop` 先把还没判定的 parse 全部判完再回答，所以它的 `pending` 是 0，新字段 `decidedAtStop` 说判了几个；没遇上任何响应的计入 `dropped`。`trace start` / `trace status` 顶层的 `weakRows` 移进这个块。
- **超出预算的摘要保留计数与前几个 id**：`net show`、`net body`、`net grep`、`analyze find` / `deps` / `chain` / `diff` / `shape` / `schema-diff`、`bundle info`（含 `--usage`）、`replay check`、`status`、`trace list`、`bundle export fixtures`、`fetch --batch`、`console show` 各有自己的摘要（计数加至多 10 个 id / 键），不再只剩长度。
- **字段名**（表见 docs/04 §2.1）：`net list` 行（http 与 ws）、`net body`、`net wait`、`net show`（`postData`、`body`、帧与 `payload`）与 `analyze find` 提示里的 `size` 改为 `bytes`；`replay check` 的正文差异改为 `recordedBytes` / `gotBytes`；`net grep` 的行与 `analyze chain` 的步骤用 `id` 指自己的请求（原 `request`）；点击 / 悬停的 `trajectory.ms` 改为 `plannedMs`；`net show` 的 `timing.total` 改为 `timing.totalMs`。包的落盘格式不变。
- **跨包回答**：`analyze diff` 与 `analyze schema-diff` 列出 `bundles: [{short, dir}]`（`short` 是目录名）；`analyze diff` 的请求行改为 `{bundle:"<short>", id}`（原 `{bundle:<序号>, ref}`）。

## 0.6.0（2026-10-17）

### plugin init（0.7-D）

- **`tabcap plugin init --kind decode [<dir>] [--name <n>] [--force]`** 写出 Python 解码插件模板，不必再去找安装把 `templates/plugins/decode-python/` 放在哪。只给 `--name` 时写到 `~/.config/tabcap/plugins/<name>/`——插件只从这里加载；给目录时名字默认取目录名，目录不在插件目录里时回答会说把它挪过去。`manifest.json` 填上名字（其余照模板），`plugin.py`、`runner.py`、`pyproject.toml`、`config.example.json` 照模板写；`config.json` 只在不存在时从样板建（0600），从不覆盖。目录非空时拒绝，除非 `--force`：改写模板文件，`config.json` 与其它文件不动。回答列出写了的 `files`、保留的 `kept`，`next` 给两步（改 `plugin.py`、`config.json` 与清单的 `match`；然后 `tabcap plugin enable <name>`）。`--kind` 目前只认 `decode`。
- 五个模板文件在构建时嵌进二进制，发布包、npm、源码三种装法的 `plugin init` 都能用；`templates/` 仍是源，单测保证两者一致。

### 观察模式：先等 grace 再判（0.6-W）

- **没有 strong 命中的 parse 最多等 1.5 s 自己的响应**：在 XMLHttpRequest `onload` 里 parse 的页面，parse 早于 tabcap 索引这条正文。那一刻若有别的加密响应在场（页面取回却从不 parse 的、并发的请求），明文以前当场判定——错的 weak 行，或候选里没有真请求的 unattributed 行。现在它等自己的响应，到了就以 strong 写入；过了 grace 才按当时在场的响应判 weak / unattributed / 丢弃。strong 行不延迟；其他行可能晚至多 1.5 s 出现。隔壁项目的 XHR 复刻页从 0/40 strong 变为 40/40；靶场 s59 为此加了 `mode=xhr` 与 `mode=xhr&linger=3`。
- `trace stop` 与 `net stop` 结束前先判掉还在等的 parse；那时一个在场响应都没遇上的计 `drops.orphan`；`drops.noFit` 仍是「有响应在场，但都装不下这段明文」。
- `trace status` / `trace stop`：`decode.held`（还在等的 parse 数）。`trace stop` 改为报停止之后的 `decode` 块，stop 时判定的行与 drop 都算进去。

### 两轮真实站点后作者定的几处（0.6-V）

- **weak 观察行可以关掉**：`config.json` 写 `{"trace": {"weakRows": false}}` 后不再写 single-suspect 行（`evidence.link: "weak"`）——到目前为止它在每个真实站点样本上都归错了；本会写入的每一行计入 `trace status` / `trace stop` 的 `decode` 块里的 `drops.weak`。默认仍是 `true`（照旧写入）。`trace start --decode` 与 `trace status` 带 `weakRows`。
- **观察模式的证据帧带脚本 URL**：`evidence.frames[].url` 以前总是 `""`，因为调用帧的脚本 id 读错了位置（应为 `location.scriptId`）；现在先用帧自己的 URL，再用脚本解析时的 URL。同一处修正也让观察模式按原设计跳过 tabcap 自己的脚本与隔离世界里的 JSON.parse。
- **解码插件不再收到 CORS 预检和空正文**：录制时与 `bundle decode` 都一样；`bundle decode` 的回答计入 `skipped: {preflight, empty}`。
- **放弃覆盖同一插件的旧失败**：插件现在放弃的正文，若当前视图正是它自己以前的 `ok:false`（旧 runner 的「returned None」），`bundle decode` 追加一行放弃行，读者（`net show`、`net body`、`find` 等）看到的是没有视图；计入 `superseded`。`bundle decode` 的命令说明提到放弃。
- **`trace status` 与 `trace stop` 带 `decodePlugins` / `decodePluginsNotice`**：观察模式开着时，与 `trace start --decode` 一样。
- **形状不计没有响应的交换**：`analyze shape` / `schema-diff` 不再推断 `incomplete` 交换（HAR 导出也不导出它们），与 `--types` 无关；`excluded` 改为 `{types, incomplete}`。包与它的 HAR 往返在这种端点上不再报漂移。
- **文档**：点击最后一个请求结束超过 300 ms 后才开的弹窗不由这次点击报告；`tab list` 里它是带 opener 的 `popup`。

### 复测修正：usage 间隔、fixtures 汇总、popup 字段、解码插件提示（0.6-U）

- **`bundle info --usage` 的间隔不算 CORS 预检**：每行的 `minIntervalMs`、`meanIntervalMs`、`maxBurst1s` 只按非预检请求算。一个真实包的 `fetch` 行最短间隔是 0.2 ms——那是预检和它的请求之间的距离。预检照旧计入 `requests`、`byMethod`、`preflights`；`firstMono` / `lastMono` 仍跨整行。
- **`bundle export fixtures` 汇总 `skipped`**：回答里的 `skipped` 按原因计数（`{"websocket": 113, "preflight": 26}`），`skippedExamples` 每个原因列至多 3 个请求 id；以前逐条列出（真实包里一百多行 websocket）。`index.json` 仍是逐条的完整列表。
- **`click` 回答之前一直在看弹窗**：真实站点上一次点击先发请求、再开弹窗，回答是 `effect: "request"` 且没有 `popup`，因为弹窗目标在点击后的等待结束之后才到。现在回答之前任何时候看到弹窗，都给 `effect: "popup"` 和 `popup` 字段。等待结束后，只在点击期间看到的请求仍未结束、或结束不到 300 ms 时继续看，总长不超过原有的 2 s 注册宽限，所以没有这种请求的点击不变慢。已进会话的弹窗标签即使目标事件没点名也能找到。
- **`trace start --decode` 列出已启用的解码插件**：`decodePlugins` 列名字，`decodePluginsNotice` 说明插件已解过的正文不再观察、插件视图优先于 `by:"page"` 视图；想看页面就 `tabcap plugin disable <name>`。

### 观察模式召回（0.6-Q）

- **按页面手里的形式比对密文**：每个候选（高熵整段 body、base64 / hex 的 JSON 叶子、裸 token）按原样、去空白、去首尾引号、URL 解码各算一份哈希。MIME 式 base64（每 76 字符一个换行，页面解密前自己去掉）现在能出 strong 行——某真实站点 91 条加密响应里 76 条是这种，此前一条也归不上。strong 行用 `evidence.matchForm`（`raw` / `stripped` / `unquoted` / `urldecoded`）说明命中的是哪种形式。带换行、带引号、URL 编码的裸 body 也进嫌疑。
- **明文不会比密文允许的更长**：每个嫌疑带一个上限（base64 × 3/4、hex / 2、高熵 body 取其字节数；假设加密前不压缩）。超过某嫌疑上限的明文不会作为 weak 行或 unattributed 候选挂到它名下；一个能装下的嫌疑都没有就丢掉这次 parse，计 `drops.noFit`（大段 localStorage 解析不再挂到小加密响应下）。strong 行不做长度检查。
- **信封竞态**：unattributed 行和 weak 行一样先等 500 ms，再对一遍已录的原始 body；某个 body 被索引时，正在等待或暂存、文本恰好等于它的 parse 计 `rawBody` 丢弃。
- **`net body` 读 page 视图**：默认回答和 `--decoded` 按 `analyze find` 的方式解析 decoded 视图（ok 的插件视图优先于 page 视图），录制中和录制后一样；page 视图的回答带 `decoded.link`。没有视图、而 body 是观察模式会武装的那种时，`next` 指向 `trace start --decode`。
- `net start` 的帮助和 `references/recording.md` 把加密的 API 响应指向 `trace start --decode`。

### 回放优先级、usage 按 actor、shape 的类型（0.6-S）

- **`replay serve --prefer 2xx|latest`**：一个键录到多条时以前按录制顺序回答，先录到一次失败的尝试（403，之后才是 200）时爬虫当场失败。`--prefer 2xx` 只用这个键的 2xx 录音回答（一条都没有时用全部），`--prefer latest` 只用最后一条；`recorded`（轮换，默认）不变。回放规则里每条规则可写同一字段（`"prefer": "2xx"`），旗标对所有规则覆盖。命中头末尾多 `;prefer=<v>`，每条路由多 `served`。`replay check --prefer` 只发、只比会被拿来回答的录音，其余列在 `notPreferred`；`bundle export fixtures` 按规则的 `prefer` 只导出会回答的录音（其余列在 `notPreferred`；夹具编号数的是写出的夹具）。
- **夹具默认跳过 CORS 预检**（`OPTIONS`，`skipped` 原因 `preflight`），`--include-preflight` 保留。`replay serve` 不变；docs/04 §31 写明了它怎样回答预检。
- **`bundle info --usage` 按 actor 分行**：每个主机 × actor 一行，`page` / `fetch`（按 `fetchId`）/ `evaluate`（evaluate 命令窗口）/ `other`，另有 `actors` 合计；`--actor <名>` 只看一个。CORS 预检单独计入 `preflights`，不再算空正文。`data:` URL 与回环主机不进表，一行 `skipped` 汇总；`--all-hosts` 列出回环主机。10 分钟窗口只计列出的请求。
- **`analyze shape` / `schema-diff` 默认只看像 API 的交换**：资源类型 xhr、fetch、document，加上响应是 JSON content type 的任何类型（一个真实包里大部分端点是带缓存参数的 css / js / 图片）。`--types a,b` 只看这几个类型，`--types all` 看全部；`excluded` 计过滤掉的条数，`filter` 写明用的类型。`schema-diff --types` 两边同过滤。按 `--types xhr,fetch` 导出的 HAR 再导入、与原包比出漂移，原因是两边的请求集合不同（同一端点有别的类型的交换，或 HAR 导出不带的 `incomplete` 交换），不是往返本身；第一种用 `--types xhr,fetch` 即可（docs/04 §32）。

### 修正

- macOS 弹窗前台交还改按 bundle identifier 激活之前在前台的应用，没有 bundle id 才退回应用名。进程名可能和应用名不同（Firefox Developer Edition 的进程名是 `firefox`），`tell application "firefox" to activate` 会报 -1728，交还永远不成功。`browser status` 的 `popupFocus` 多了 `lastSeenBundleId`，启动时的 `front` 报告多了 `beforeBundleId`。

### 解码插件：放弃的交换、模板随包（0.6-T）

- 解码插件可以回答「不是我的正文」：线路上 `{"id":N,"declined":true}`。不写视图，也不算失败（不再计入让插件停用的三次失败）。Python runner 在 `decode()` 返回 `None` 时发这个回答；以前这会写成一条 `ok: false` 的视图（「plugin.decode returned None」）。录制与 `tabcap bundle decode` 规则相同；`bundle decode` 在 `decoded` / `failed` 旁边报 `declined`（所有匹配插件都放弃的侧数）和 `declinedBy`（按插件）。「是我的但解坏了」的正文请抛异常，那仍是失败视图。
- `templates/plugins/decode-python/` 现在随发布包和 npm 包一起带（全局安装后在 `$(npm root -g)/tabcap/templates/plugins/decode-python/`），skill 的分析参考里写了它的位置。

### click 的弹窗 effect 与会话残留（0.6-R）

- **`click` 报弹窗**：默认（DOM）`click` 打开了页面（`window.open`、新窗口：opener 是被点标签的 page target，它以 `popup` 标签进会话）时，回答是 `effect: "popup"` 加 `popup: {tab, url}`（会话里的标签 id；知道时带地址），`note` 指向 `--tab <id>` / `tab select <id>`。以前报 `effect: "none"` 并建议 `--trusted`。弹窗优先于其余几种效果，只报第一个。
- **`fill --secret` 要求会话已绑站点**：没被 `session start --site` 绑过的会话（`net start`、`navigate` 建的，包括 `session start --site` 失败之后建的）里，`fill --secret` 在碰页面之前报 `not-found`，`next` 给 `tabcap session stop <name>`，再 `tabcap session start <name> --site <site>`。以前会悄悄填该站点的第一个账号。`net start`、`navigate` 仍隐式建会话。
- **`session start --site` 失败不留残留**：错误里说明会话没有启动；账号的浏览器上下文开了之后再失败，上下文会被销毁，后来同名的隐式会话不会把标签开进去。

### fetch 的 credentials 与 session export 的 origin（0.6-P）

- **`tabcap fetch --credentials include|same-origin|omit`**（默认 `include`，即原行为）：就是页面 `fetch()` 的 credentials 选项。回 `Access-Control-Allow-Origin: *`、或发 `Access-Control-Allow-Credentials: true, true` 的 API 只能用 `omit` 读（不带 cookie；API 靠头认证时没问题）。`--batch` 每行可带 `credentials`（命令行的值是没写的行的默认），`POST /fetch` 收 `credentials` 字段，`_tabcap_fetch.py` 的 `fetch()` 多一个 `credentials` 参数。这次 fetch 录下的每个请求都记着所用模式（`fetchCredentials`），命令开始事件也记（`input.credentials`）。
- **`fetch.blocked` 的 `next` 更准**：Chrome 的理由是通配源或 `Access-Control-Allow-Credentials` 不对、且模式是 `include` 时，提示先说改用 `--credentials omit`、那样不带 cookie；导航到 API 源的页面放第二条，并提醒 Origin / Referer 会跟着变（真实站点的后端因此回过 403）。不做 `--referrer`：页面 fetch 只能发同源 referrer。
- **`tabcap session export --origin <url|host>`**：认证头取自录制里发往该源的最近一条请求（不论当前是哪个标签），cookie 在页面的之外加上该源的；标签上不再需要该源的 frame。不给 `--origin` 时，页面源没收到像认证的头，就改用录到的、带这类头最多的 host，并在输出里说明：`source.headers` 改成 `{request, origin, auto}`（原来是 `"r-N"` / `"none"`）。值照旧永不打印。
- 靶场 s60（127.0.0.1 上两个源）与 `test/e2e/v06p.e2e.test.ts` 覆盖以上全部。

### README 重写

- 两份 README 改回给人读的样子：是什么、为什么、快速开始、做什么、命令分组一览、同类对照、边界、平台、文档。生成的全量命令表从 README 里拿掉，完整参考只在 `skills/tabcap/references/commands.md`（`bun run gen:docs` 现在只写这一个文件）。

### 观察模式补丁（0.6-L2）

- **明文改走 log-point**：`JSON.parse` 断点的 condition 在 `console.dirxml` 仍是原生函数时发出被调实参（页面换掉它则退回暂停+作用域，不调用页面函数）。axios 式 `transformResponse`、内联 `JSON.parse(decrypt(…))`、worker 回字符串再 parse，都能归到对应响应；信封和 `/api/plain` 对照按原文 sha 排除，不再写成 `by:"page"` 视图。
- **明文上限 16 MiB**（原 1 MiB，仍低于 blob 的 32 MiB）。
- **裸 base64 / hex 正文**（≥64 字符、无 JSON 信封）也进嫌疑窗口。
- **single-suspect 先等 500 ms** 再写，避免对照接口的 parse 抢到唯一嫌疑。
- **录完就关**：`trace start --decode` 的提示和 `references/trace-and-probes.md` 写明每次 ≥32 字符的 parse 都暂停，表格密集或 WebSocket 高频 parse 会变慢。请求侧加密、SSE / 分块、Worker `postMessage` 对象仍不覆盖。
- **强关联与弱关联**：每行用 `evidence.link` 说明它和请求怎么连上的。解析帧够得着密文时是 `"strong"`——现在也包括原始响应文本（axios 的 `transformResponse(data)`）和普通对象往下一层的字符串（`env.data`）。只因为窗口里只有这一个嫌疑时是 `"weak"`；`analyze find` 在这种视图里的 hit 带 `"link":"weak"`，`trace status` 记作 `rows.weak`。
- **`--decode` 不再装签名断点**（不读 API 列表，只留安装通道）；`--decode --apis` 报用法错误。帮助和文档把对页面做了什么写准：不改页面状态，在页面里只调用 log-point 的原生 `console.dirxml`。
- **修正**：嫌疑在作用域 walk 期间才到的暂停会被暂存后丢掉（四个变体里约有一个零行）；500 ms 的 settle 实际等满 5 s 窗口；原文 sha 集合到 8192 条就不再收（长录制里信封又会被当成明文）；先 `trace start --decode`、后 `net start` 时，已加载页面要等下一次导航才有 sink。log-point 行和暂停还按位置配对（log 的调用方帧就是暂停顶帧），丢了暂停的行计 `drops.unpaired`。

### 代理也看得到 loopback；mitmproxy 导入有类型和耗时（0.6-N）

- **`tabcap browser start --proxy <url>` 现在在 `--proxy-server` 旁一并传 `--proxy-bypass-list=<-loopback>`**，127.0.0.1、localhost、[::1] 的流量也经过代理（去掉 Chrome 默认的 loopback 直连）。`--proxy system` 与 `--proxy none` 不变。账号池代理（`proxy add` / `account bind`）的 browser context 没有自带 `--bypass` 列表时同样带 `proxyBypassList: "<-loopback>"`，已存的列表仍优先。守护进程自己的 CDP 管道不受影响。
- **HAR 导入在没有 `_resourceType` 时推 `type`**（mitmproxy、Charles）：先看 `sec-fetch-dest`，再看响应 `content-type`，是 docs/04 §9.2 里的固定表。推出来的事件带 `typeInferred: "sec-fetch" | "content-type"`，`bundle info` 计数（`typeInferred`）。`replay export-python` 与 `analyze` 现在能处理 mitmproxy 的导入包。
- **HAR 导入保留 `time` 与 `timings`**，写进 `timing`（start、responseStart、end 和重建的 `cdp` 偏移）；`bundle export har` 读得回来。除非某条一个数都没有，`timing` 不再列在 `lossy` 里。

### 回放键规则与夹具导出（0.6-C）

- **回放规则文件** `replay-rules.json`（schema `tabcap-replay-rules/0`；不给 `--rules` 时读 `config.json` 的 `sites.<包的站点>.replay`，再接 `replay`，两处都是 `{rules:[…]}`）：`{rules:[{match:{host?, path?（glob）, method?}, key:{ignoreQuery, ignoreBodyFields, body: raw|form|json|decoded|none, decodeWith?, caseInsensitiveQuery?}, response:{compare: status|status+body|status+decoded-body, ignorePaths, decodeWith?}}]}`；第一条 match 符合录到的请求的规则生效，默认规则就是原来的行为。按不可信输入校验（不认识的键、自相矛盾一律拒绝，大小有上限）。`form` 按排序后的字段对作键，`json` 按规范 JSON，`decoded` 按解码插件的明文（录到的视图，或 `decodeWith` 现场解录到的字节；规则点名的插件不必启用），先去掉忽略的名字 / JSON 路径（`$.a[*].b`）。
- **`replay serve --rules`**：只在被忽略的部分、表单字段顺序、JSON 写法或密文上不同的请求现在能配上；`x-tabcap-replay: r-N;n=k;rule=<id>` 写明用了哪条规则，`x-tabcap-replay-ignored: query=…;body=…` 列出被忽略但不同的部分；404 给 `request.rule`，每个候选给 `rule` 以及按该规则比出的 `differs.query` / `body` / `ignored`。启动回答多 `rules:{source, file?, site?, rules}` 与 `routes[].rule`。
- **`replay check --rules`**：每行多 `rule`；`compare: "status"` 不比正文，`ignorePaths` 从两边 JSON 去掉，`status+decoded-body` 用同一个插件解开两边再比（哪边解不开，该行 `unverified` 并写明原因）。结果多 `rules`。
- **`tabcap bundle export fixtures <包> --out <目录> [--rules f] [--format json|<插件>] [--no-redact]`**：每条可回放的交换一个夹具 `fixtures/<n>-<METHOD>-<路径 slug>.json`（`{schema: "tabcap-fixture/0", key:{method, path, query, body}, request:{url, headers, body}, response:{status, headers, body | bodyFile, decoded?}, meta:{request, rule, recordedAt, keyBody}}`，大的或二进制正文放 `bodies/`），另写 `index.json`；默认像 HAR 导出一样脱敏，键也从脱敏后的包算（`--no-redact` 保留登录体连同密码）；`--out` 必须是新的或空目录；文件 0600。
- **夹具插件**：插件清单写 `"kind": "fixture"`（同一插件目录，用 `--format` 点名，不必启用）；协议 `tabcap-fixture/1`，与解码插件同样的 JSON 行：`{"id","op":"fixture","fixture"}` → `{"id","files":[{"path","encoding","data"}]}`，写到 `--out` 下（只许相对路径，一个回答最多 64 个文件，有 `maxBytes` 上限）。`plugin list` 显示 `kind: "fixture"` 与 `fixtureProtocol`。
- **`bundle export har --rules <file>`** 只把各规则忽略的 query 参数从条目的 URL 与 `queryString` 去掉，别的不变。
- `replay export-python`（链模式）挑目标与 `analyze chain` 的默认目标同一条规则（导出的请求里有数据、开始时间最晚的那条），不再按事件流里的最后一条。

### 页面内解码·观察模式（0.6-L）

- **`tabcap trace start --decode`**（配合 `net start` 录制；`--no-decode` 关闭；config.json `trace.decode` 设默认）：站点把 API 响应体加密时是页面自己的 JS 解密的——观察模式借这个。开启期间页面上常设三个 sink 断点（`JSON.parse` 带实参长度 condition；`TextDecoder.prototype.decode` 与 `SubtleCrypto.prototype.decrypt` 只计 evidence，**绝不读 CryptoKey**）；像密文的已完成响应进入 5 秒嫌疑窗口；页面交给 `JSON.parse` 的明文从暂停帧的 local/closure 里恢复（函数调用断点读不到被调实参——实测），按密文候选的 sha256 与暂停作用域字符串的匹配归属，作为 `by:"page"` 的 `decoded` 视图写进 `decoded.jsonl`。`find` / `where` / `deps` / `recon` / `replay check` 经内置链步骤 `page` 搜索它。归不到具体响应的明文保留（`request: null`、列出候选，每录制至多 50 行）；归属规则是 scope-string、再唯一嫌疑——**绝不按时间取最近**。ok 的插件视图仍优先于 page 视图。只读：只断点，不改页面任何值。

### 与 mitmproxy / Burp 互通（0.6-M）

- 只有文档和样本，行为不变：[docs/13](docs/13-interop-proxies.md) 写了在 `tabcap browser start --proxy <url>` 后面串联 mitmproxy / Burp（传给 Chrome 的参数）、导入 mitmproxy `hardump` 的 HAR 及字段丢失表、mitmproxy 的 `response(flow)` 与 tabcap 的 Python `decode(flow)` 对照。新增样本 `test/fixtures/har/mitmproxy-range.har` 与导入测试。

### 真实项目试用后的分析与输出脱敏（0.6-E）

- **`analyze deps` 认出带前缀的头值**：头的值整体对不上响应叶子时，去掉开头的 `Bearer ` / `Basic ` / `Token ` / `JWT `（大小写不限）和首尾引号再比，于是 `Authorization: Bearer <token>` 追到 token 接口的 `$.access_token`；来源（以及 `analyze chain` 里提供它的那一步）带 `prefix`（结尾引号另有 `suffix`）。`--write-findings` 去掉前后缀后复读叶子（实测）。`replay export-python` 的参数是去掉前缀的值，发送时拼成 `"Bearer " + authorization`。
- **新的 deps 类 `caller-input`**：没有来源、不是 cookie、不像签名（`looks-signature` / `looks-random`）、名字不敏感，且名字在固定表里（page、pageSize、limit、offset、from、to、period、year、month、groupBy、sort、q …，表见 docs/04 §15）或录到的值都是普通值（6 位以下的数字、true / false、日期、一个短单词）。它不算 `unresolved`；`analyze chain` 把它列在新的 `inputs` 里而不是 `todo`；`replay export-python`（链模式）把它生成为普通参数、默认值是录到的值，不带 TODO。其余照旧 `computed-in-page`。`analyze chain` 的默认目标改为**开始时间最晚**的有数据 xhr / fetch / document 请求（`timing.start`，没有就用 `mono`；事件顺序只作并列兜底），不再是事件流里的最后一条（编号在响应写入时才分配，慢的登录 POST 可能排在数据请求之后）。靶场 s06 的 `q` / `page` 现在是 `caller-input`；新靶场页 s53（token 接口，然后 `Authorization: Bearer`）覆盖前缀。
- **实时输出打码**：`net show`、`net list`、`net body`、`fetch`（含 `POST /fetch`）、`recon`、`trace list` 按 `bundle redact` 的名字规则（default@2）把值显示成 `<redacted:<名字>>`：名字敏感的头（`authorization`、`x-api-key`、`*token*`、`*auth*`、`*session*` 及名字规则）、每个 cookie / set-cookie 的值（名字和属性保留）、名字敏感的 query 与请求体字段（URL、`location`、postData、档案里的 URL、trace 的脚本 URL）。`x-csrf` 不算敏感。整值是库里秘密的仍显示 `<secret:…>`。这些命令加 **`--reveal`**（`POST /fetch` 用 `reveal: true`）打印录到的原值。证据包不变（它就是证据），HAR 导出照旧打码。
- **`replay export-python` 少发头**：默认每个函数只发浏览器不会自己加的请求头：`content-type`、`authorization`、不是 Chrome 默认值的 `accept`、与请求不同源的 `referer`，以及浏览器默认头表以外的头（自定义 `x-*` …）；`user-agent`、`accept-language`、`origin`、`sec-ch-ua*`、`sec-fetch-*`、`priority`、缓存与条件请求头都不发，也不为它们生成参数。**`--browser-headers`** 恢复原来的输出。头表与 `session export` 用的是同一张（移到 `replay/common.ts`）；`client.py` 开头写明按哪种方式生成。
- **帮助索引**：诊断命令（`trace`、`fingerprint`、`wire`）归到 `tabcap --help` 末尾的 `Diagnostics (optional)` 组（`tabcap help diagnostics`），排在 `Other` 之后；README 的生成表把它们放进表尾单独的小表，`references/commands.md` 里是最后一节。MCP 核心集与 SKILL.md 本来就不含它们（未改）。

### 会话导出（0.6-F）

- **`tabcap session export --for requests|httpx|playwright --out <文件> [--origin <url>] [--tab t2]`** 把已登录标签的会话交给脚本：cookie（该源的 `Network.getCookies`，池账号再加会话自己浏览器上下文里的）、页面为认证发出的头（取发往该源 host 的最近一条带这类头的录下请求：按 `bundle redact` 规则的敏感头，加 `x-csrf*`、`x-xsrf*`、`*-token`、`*-auth*`、`api-key`，以及页面自己设、不是浏览器默认的头；`cookie` 归入 cookies，`proxy-*` 永不导出）和 localStorage / sessionStorage（在 tabcap 隔离世界里读，超过 64 KB 的值跳过并列出）。没在录时 `headers` 为空、`source.headers` 为 `none`，提示先 `net start`。
- 格式：`requests` 是 JSON（schema `tabcap-session-export/0`：origin、capturedAt、cookies、headers、storage、note）；`httpx` 是可直接 import 的 Python 模块（缺 `.py` 自动补），含 `cookies`、`COOKIE_RECORDS`、`headers`、`storage` 和 `client(base_url)`；`playwright` 是 `replay session` 的 storageState，放不下的头和 sessionStorage 在 `omitted` 里报。
- 文件权限 0600（新建目录 0700），里面是活的凭据；输出只有路径、计数和头名（`{file, for, origin, mode, cookies, headers, storage, source, note}`），录制包里照常只记带计数的 `cmd` 事件。
- `replay export-python` 生成的包附带 `_tabcap_session.py`（读 JSON 导出、建 httpx 客户端，运行时不依赖 tabcap），包里的 README 写了用法。

### 经已登录标签发请求（0.6-A）

- **`tabcap fetch <url>`** 由会话的标签发一个请求并录下（需要 `net start`）：在标签主帧的 tabcap 隔离世界里用页面自己的 `fetch()`（`credentials: "include"`），带页面的 cookie、受页面的 CORS 规则。`--method`、`--header k:v`（可重复）、`--body <text|@file>` / `--json <text|@file>` / `--form k=v`（可重复）三选一；`--tab`、`--timeout`（含等本主机轮次的时间）。回答：`{id: "r-N", fetchId: "c-N:f-K", status, statusText, mime, bytes, headers（content-type、content-length、content-encoding、content-disposition、location、cache-control、etag、last-modified、retry-after，已脱敏）, body（≤ 8 KB 的文本）| bodyFile, timing: {startMono, endMono, ms}, waitedMs}`；`--out <file>` 把正文写到该文件，`--raw` 以 `bodyBase64` 返回（≤ 16 MB）。文本正文不论去哪都先做秘密值替换。
- **确定的归属**：一次 fetch 录下的每个请求都带 `fetchId`，`cmd` 是这次 fetch 自己的命令窗口，同时开着几个命令也不串。同源请求带标记头 `x-tabcap-fetch`，录制器在 Fetch 的 Request 阶段把它去掉再放行（服务器收不到，录下的请求头里也没有）；跨源请求不带标记（会逼出 CORS 预检），按发起栈上助手脚本的唯一函数名与 scriptId 认。fetch 的 `cmd` 结束事件在 `outputSummary.requests` 里列出它的 `r-N`。
- **按主机限速**：`config.json` `fetch: {minIntervalMs: 3000, concurrency: 1}`，可按库站点在 `sites.<name>.fetch` 覆盖；同一主机的请求按到达顺序排队，`waitedMs` 报告等了多久，命令行没有跳过它的开关。
- **停手规则**：`--stop-on`（可重复，加在 `config.json` `fetch.stopOn` 之后）：`empty-body`、`status>=<n>`、`status=<n>`、`json:<$.path>=<value>`、`json:<$.path>!=<value>`、`text:<regex>`。命中时响应照常录下，命令以 `fetch.stopped` 失败（规则、说明、`request`，完整回答在 `result`），写一条原因为 `fetch-stop` 的 `guard` breaker 事件，此后发往该站点的 fetch 一律 `guard.stopped`，直到 **`tabcap guard resume --site <站点>`**（新命令），或会话恰在等人时 `handoff continue`。会话不会因此进入 `waiting`。
- 被页面 CORS 规则拦下的 fetch 以 `fetch.blocked` 失败，附 Chrome 的控制台原话。会话交给人期间 `fetch` 与其他动页面的命令一样等待，并计入账号的每小时预算。
- **`tabcap fetch --batch <file.jsonl>`**：每行一个请求，在一个命令里按序、按同样的限制发出（`fetchId` 为 `c-N:f-1`、`f-2` …），每行打印一个信封。
- **`POST /fetch`**：守护进程原有监听上的新路由（Unix 套接字；Windows 上是回环 TCP 加 bearer token）：`{session, tab?, url, method?, headers?, body?|json?|form?, timeoutMs?, stopOn?, rawBody?}` → 同一个信封。`replay export-python` 在客户端旁写出 **`_tabcap_fetch.py`**，一个调用它的小 httpx 助手（`TabcapFetch(session).fetch(url, …) → (status, headers, bytes)`），生成的 README 里以「Route an existing scraper through the browser」一节说明。
- `net start` 的 `instrumentation` 说明加了一句：同源 fetch 进行期间，该标签的 fetch() 请求也会在 Request 阶段停一下。

### 真实项目试用后的守护进程修补（0.6-D）

- **DOM 支撑的 ref**：`snapshot --css` / `--xpath` 命中、却没有无障碍节点的元素（UI 库把输入框、按钮从无障碍树里藏掉）现在也有 ref，打印成 `(no accessible node) <input#id.class> [e31]`：与普通 ref 一样绑 backend node id、帧与 loaderId，一样失效。`click`、`fill`、`type`（在 `fill` / `click` 聚焦它之后）、`hover`、`upload`、`html`、`screenshot --ref` 都收它。`search.domRefs` 计数。
- **点击效果**：默认（DOM）`click` 的回答说明点击后的等待里发生了什么：`effect: "dom" | "navigation" | "request"`（最先看到的那个），页面什么都没做时是 `effect: "none"` 加一条建议 `--trusted` 的 `note`（处理程序只认可信输入）。只观察（tabcap 隔离世界里的 MutationObserver、Page / Network 事件；没在录制时只为这次观察临时开 Network）；退出码不变；`--trusted` 与 `--no-wait` 不报效果。
- **`find` 搜子帧**：根文档与帧树里的每个帧；帧里的命中带 `frame` 与帧路径 ref，回答带 `frames`（搜了几个帧）。`where` 判日期顺序时也读全部帧的页面文字。
- **被重定向回答的 POST 保留请求体**：录制器写被重定向的那一跳时没带请求体（`postData: null`）；现在按常规规则存（≤ 64 KiB 内联，否则 blob），下一跳的 `redirect.from` 仍指向它。
- **图片验证码提示**：登录表单旁的图片验证码（图片的 src / id / class / alt / 标签含 captcha / verify / 验证码 / 校验码，或输入框名字像 captcha / vcode / verifyCode）让 `snapshot` / `outline` 头多一行 `challenge  image-captcha img [e12] → input [e13]; …`、JSON 多 `challenge`，对该表单的 `fill` / `click` 带 `challenge: {kind, image, input}`，每个页面写一条 `guard` 事件 `{event: "challenge", detail: {kind: "image-captcha", advisory: true, …}}`。不等待、不拒绝：模型自己读图（`screenshot --ref`）或叫人。其他挑战照旧转交。
- **一账号一浏览器上下文**：每个绑了账号的 `session start --site <s>`（含 `--account auto`，也含没绑池代理的账号）都有自己的 browser context，开始时恢复该账号的 cookie，并像池账号一样回写，第二个账号不会再撞见第一个账号已登录。不带账号的会话用默认 context。

### 解码插件（0.6-B）

- **解码插件**：`manifest.json` 写 `"kind": "decode"` 的插件（同一个 `plugins/` 目录，`tabcap plugin enable` 才生效）按 host 通配、路径通配、内容类型与方向匹配并解码请求 / 响应正文。它是你自己的进程外程序，说 `tabcap-decode/1`：stdin 上一行一个 JSON 请求（`{id, op: "decode", direction, request: {id, url, method, headers}, response?: {status, headers}, body: {encoding: "base64", data, mime}}`），stdout 上一行一个回答（`{id, ok: true, mime, body: {encoding: "utf8" | "base64", data}, note?}` 或 `{id, ok: false, error}`）。每个守护进程每个插件一个长驻进程，每次调用有硬超时（`timeoutMs`，默认 5000）和大小上限（`maxBytes`，默认 8 MiB）；超时、崩溃或回答不合协议会重启进程，同一录制累计 3 次就在录制余下时间停用该插件并写一条 `note` 事件。cookie 与 authorization 类头从不发给它；密钥留在它自己的 `config.json`，tabcap 从不读。清单严格校验（不认识的键拒绝，16 KB 上限）。
- **解码视图**：明文存成 blob 放在原正文旁边，请求事件里以 `request.decoded` / `response.decoded` = `{by, version, direction, mime, blob, bytes, ok, error?}` 引用；原正文不变。`analyze find`、`where`、`analyze deps`（从解码后的请求体取输入、在解码后的响应里找来源）、`recon`（通道 `decode`）与 `replay check`（两边都用同一插件解码后比较）都读它，解码链第一步记作 `plugin:<名字>`。脱敏与 HAR 导出像正文一样处理视图。
- **`tabcap bundle decode <包> [--plugin 名字]`**：给插件出现之前录的、已结束的包补上解码视图。视图追加到包里的 `decoded.jsonl` 旁路文件（`{seq, request, direction, decoded, at}`，同一请求同一方向以最后一行为准），`events.jsonl` 永不改动；读包时把旁路文件叠加到请求事件上，所有命令看到的与录制时写入的一样；重跑只追加新的或变了的视图。`bundle info` 报 `decodedSidecar`。
- **`net body`**：有解码视图时默认给视图（`view: "decoded"`），`--raw` 给原文（`view: "raw"`），没有视图时 `--decoded` 报错。`net show` 列出两侧的视图；`net start` 写出生效的解码插件；`plugin list` 显示 `kind` 与 `match`。
- **Python runner 模板** `templates/plugins/decode-python/`（`manifest.json`、`pyproject.toml`、`runner.py`、示例 `plugin.py`）：拷进 `plugins/<名字>/`，按 mitmproxy 的形状写 `decode(flow)`（`flow.request.url / method / headers / content`、`flow.response.headers / content`）；用 `uv run --project . runner.py` 或 `python3 runner.py` 运行。mitmproxy addon 的 `response(flow)` 函数体通常可以原样搬过来。

### 账号使用报告（0.6-H）

- **`tabcap bundle info <bundle> --usage [--text] [--business-code <$.路径>=<ok 值>]...`** 离线数出一次录制做了什么（schema `tabcap-usage/0`）：`logins`（登录尝试次数、按账号分、`guard` 事件名单），按主机（`host:port`）的请求数、方法、状态码、首 / 末请求开始时刻、相邻请求开始的最短与平均间隔、任意 1 s 内最多请求数、空正文（有响应但没有正文、0 字节或只有空白，3xx 除外）、业务错误和已存正文字节数；`stops`（guard 熔断事件，如 `fetch-stop` 及其规则与请求）和 `windows`（按 UTC 10 分钟的请求数）。`--business-code` 可重复：JSON 正文里该路径的值不等于 ok 值（路径上没有值也算）记一次错误。只有计数与名字，没有任何值；`--text` 打一屏文本，可贴进运行记录。不带 `--usage` 的 `bundle info` 不变。

### 点击落到真正监听的元素上（0.6-J）

- **默认 `click` 一个 ref 之前先只读地看处理程序在哪**：目标与往上至多 3 层祖先上的 click / mousedown / pointerdown / touchstart 监听器（`DOMDebugger.getEventListeners`），以及它的后代（深度 ≤ 4、至多 64 个、广度优先）上的监听器与框架标记（`lay-event`、`onclick`、`role=button`、`href`、`data-*` 点击钩子、元素自己设的 `cursor:pointer`）；没有盒子的后代跳过。页面脚本在 tabcap 的隔离世界里跑，不改页面。
- 判定：目标或祖先在监听 → 照旧点目标；否则恰好一个后代在监听或带标记 → 点它，回答带 `target: {ref, landedOn: {tag, text, selector}, reason: "descendant-listener"}`；有好几个 → 照旧点目标，回答列出 `candidates: [{ref, tag, text, selector, by}]`（DOM 支撑的 ref，模型自己挑）；哪儿都没有（框架在根上委托，如 React / Vue）→ 不变。`--trusted`（与 `--dbl-click`）用同一个落点：指针停在那个后代的中心。
- **`snapshot --interactive`** 给点击会落到后代上的控件加 `landing="child"`（每个文档至多检查 300 个控件；监听元素超过 2000 个的文档不标）。

### 按资源类型取正文与站点停手规则（0.6-I）

- **`tabcap net start --bodies all|api|api+script|none`**（缺省取 `config.json` `record.bodies`，再缺省 `all`）：`api` 存文档、XHR / fetch、WebSocket、EventSource 和其余非静态响应的正文；`api+script` 再加脚本（`net body --at`、追踪模式要它）；图片、字体、样式表、媒体在两者下都只记元数据；`none` 不存任何响应正文。跳过的正文不向 Chrome 要；其 `request` 事件照常有状态、头、时序，`response.body` 是 `{skipped: "resource-type"}`，`net list` 的行带 `bodySkipped`，manifest 记 `record.bodies`，`net body` 会说明是哪个模式跳过的。靶场上带 1.5 MiB 脚本的页面，`api` 包比 `all` 包正好少了脚本、样式表、图片的字节数。
- **站点停手规则**：`config.json` `sites.<名>.guard: {stopOn: [<规则>…], consecutiveNon200: N}`（规则语法同 `fetch --stop-on`）。guard 对会话里该站点每一条最终录下的 document / XHR / fetch 响应求值（页面自己的请求、`tabcap fetch`、导航；正文类规则只在正文确知时求值）；`consecutiveNon200` 按响应到达时间（`timing.end`）而不是写出顺序计连续，任何 2xx 打断。命中写 `guard {event: "breaker", reason: "stop-rule", rule, request}`，会话进 `waiting`（截图与 `next`），该会话的页面操作命令和发往该站点的所有 `fetch` 以 `guard.stopped` 拒绝（触发它的那条 fetch 回 `fetch.stopped`、`reason: "stop-rule"`）。`handoff continue` 恢复会话并解除站点停止；`guard resume --site` 也一并结束它引起的 `waiting`（回 `handoffResumed`）。`fetch --stop-on` 是每次调用的覆盖：给了它，这次响应不跑站点的 `stopOn`（仍计数）。config.json 里有坏规则时 `net start` 回 `bad-input`。登录次数限制不变。
- `net start` 的答案带 `bodies`；`guard.stopped` 与 `guard` 事件带 `reason`（`fetch-stop` 或 `stop-rule`）。`bundle info --usage` 不把跳过的正文算作空正文，站点规则的命中在 `stops` 里记为 `stop-rule`。

### 响应形状与 schema 漂移（0.6-G）

- **`tabcap analyze shape <bundle> [--request r-N | --template 'GET /path'] [--text] [--write]`**：按端点（方法 + `recon` 的路径模板，合并它录到的全部交换）推断 JSON 响应的形状和请求的形状（query 名、请求体字段），schema `tabcap-shape/0`：类型树 `{kind, fields: {名字: {type, optional, samples}}, items, enum, format, variants}`，kind 有 object / array / string / number / boolean / null / union，format 有 date / datetime / int / float / id / url / email，枚举最多 8 个（会重复出现的短词；`bundle redact` 名字规则判为敏感的字段不给）。有解码插件视图时读视图，否则沿 gzip / deflate / base64 / jsonp / ndjson / sse 找到 JSON。输出里从不出现值。上限：每个端点 2000 个字段、深度 32、每个数组取前 200 个元素。什么都推不出的端点只在 `unshaped` 里列名。`--write` 把结果存进包的 `exports/shape.json`（0600）。
- **`tabcap analyze schema-diff <旧包> <新包> [--template …] [--text] [--write]`**：两份形状按端点配对，schema `tabcap-schema-diff/0`：`added` / `removed`（`路径:类型`，如 `$.items[].name:string`、`query:v:string(int)`）、`changed`（`{path, from, to}`）、`optionalityChanged`、`enumChanged`，判定 `same | drift | new | gone`；`--text` 一行一个变化。**有端点漂移时退出码 1**（信封仍是 `ok`），可放 cron。JSON 接口在新录制里回了 HTML，算漂移（全部 removed）；一边的数组一个元素都没有时，数组下面的位置不比较。
- 靶场：s06 加 `GET /api/list` 与变体 `?v=2`（改名一个字段、改一个类型、加一个字段）；e2e `v06g`。规范：[docs/04 §32](docs/04-evidence-bundle-spec-v0.md)。

### 定位（0.6-K）

- README「位置」一节与 docs/12：tabcap 与 Integuru、agent-browser 的 derive-client、Unbrowse、HAR 回放（Playwright `routeFromHAR`、VCR.py）的对照，附能力表；每一格或引自该产品自己的文档（2026-10-16 读取），或在本地靶场复现（输出与靶场脚本在 `docs/compare/`）；找不到来源或没跑的列为待验。

## 0.5.0（2026-10-16）

### 变更

- **输出预算**（0.5-C）：命令的 `data` 超过 `TABCAP_OUTPUT_LIMIT` 字节（默认 16384；`0` 关闭）时，整份 `data` 写进文件，回答变成 `{summary, file, bytes, truncated: true}`。文件在会话当前录制包的 `exports/<command>-<seq>.json`，没有在录时是 `<cache>/outputs/<时间>-<command>.json`（0600）。摘要保留顶层的全部标量字段，数组、对象与长字符串只给长度；`analyze deps` 另给每个请求的输入数与未解析数，`recon` 给档案摘要块，`trace list` 给 API × 脚本计数，`where` 给前 5 个候选。`--full` 原样全打。`net list`、`console list`、`snapshot` 与 `schema` 不受此限。
- **所有命令都有输出过滤**：`--select <path>`（点号键、`[n]`、`[*]`）、`--grep <regex>`（数组里 JSON 文本匹配的元素；长文本或多行字段按行匹配，带 `line` 行号与前后 `--context n` 行；最多 `--max-matches 50` 条；正则不超过 256 字符、`u` 标志）、`--fields a,b,c`（数组元素只留这些键）。在 CLI 里按此顺序执行、先于预算；信封多一个 `filter: {select, grep, fields, matches, total, capped}`（用 `--select` 时还有 `selected`）。`tabcap schema --json` 在 `sharedFlags` 里列一次。
- **`tabcap --help` 改为索引**：每条命令一行，分组同命令参考，摘要截到 60 字符，总量不到 6 KB。`tabcap help <命令>` 打该命令的完整帮助（同 `tabcap <命令> --help`）；`tabcap help <组>`（如 `network`，或命令词 `net`）打组内每条命令的完整帮助。
- 默认值：`net list` 与 `console list` 每页 30 条（原 100；`--page-size 0` 仍是全部）；`snapshot`（以及动作命令的 `--snapshot`）截到 12000 字符（原 60000），`snapshot` / `outline` 被截时说明怎么拿更多（`--max-chars`、`--interactive`、`--frame`）。
- skill：`SKILL.md` 控制在 8 KB 以内（规则、录 → 析 → 回放的流程、凭据、交接、输出预算与 10 行速查）；其余内容按主题移到 `references/`（`recording.md`、`analysis.md`、`pools.md`、`trace-and-probes.md`、`replay.md`、`mcp.md`）。`bun run validate:skill` 检查 8 KB。
- 凭据规则：推荐由人录入密码（`site add` / `account add` 在提示符下输入或 `--password-stdin`），但不再只限于人：用户把值交给 agent 的，agent 可以用 `--password-stdin` 存一次（不需要终端），此后只用 `<secret:…>` 引用。`site add`、`account add`、`proxy add` 的帮助、skill、docs/04 §8.1 与 README 都改成这样写；代码原本就允许。
- README：五点不同改写为 0.4 的样子（凭据存一次、之后只用引用；「不带任何解法」旁加上用户自己写挑战处理程序的插件接口；`where`、`analyze deps` / `chain`、`export-python` 的 `verify()`、`recon`、追踪模式与两个探针），中文版与英文版信息一致。

- **`tabcap mcp`（0.5-A）**：stdin / stdout 上的 Model Context Protocol 服务，手写（JSON-RPC 2.0，每行一条消息，不加依赖）：MCP 2025-11-25 的 initialize 生命周期（客户端要 2025-06-18、2025-03-26、2024-11-05 时照回它的版本）、`ping`、`tools/list`、`tools/call`；stdout 只出 MCP 消息，日志进 stderr；stdin 关闭后等进行中的调用答完即退出。
- **工具由命令注册表生成，分两套**（宿主会把全部工具定义放进模型上下文）：默认是 **24 个核心工具**（定义共 8.5 KB）——`session start` / `stop` / `list`、`navigate`、`snapshot`、`outline`、`click`、`fill`、`type`、`press-key`、`hover`、`wait`、`screenshot`、`evaluate`、`net start` / `stop` / `list` / `show` / `body`、`handoff status` / `continue`，一行说明、属性不带说明，外加 `tabcap_handoff_wait`、**`tabcap_run {argv}`**（跑任意其它命令，argv 同命令行）、**`tabcap_help {command?}`**（命令表：用法与该走的工具；或单条命令的帮助文本与 schema 条目）；**`tabcap mcp --all-tools`** 改为每条命令一个工具、带完整帮助（83 个，58 KB）。命令工具名为 `tabcap_` + 命令路径（空格换 `_`：`tabcap_navigate`、`tabcap_net_list`、`tabcap_press-key`）；`inputSchema` 来自位置参数（choices → `enum`）与长 flag 的 camelCase（`--page-size` → `pageSize`，可重复的 → 字符串数组）；守护进程命令都带 `session`、`timeout`。两套都没有、`tabcap_run` 也拒绝的：`mcp`、`daemon run`、`site add` / `proxy add` / `account add`（从 stdin 读口令，而 stdin 是 MCP 通道）、前台服务器 `fingerprint serve` / `wire serve` / `replay serve`；`schema` 不单列工具；只改打印形式的 `--text` / `--json` 不进表（工具总是返回信封）。
- **`tools/call` 在进程内走 CLI 自己的 `run()`**（不经 shell，同一套解析、校验与秘密值替换），把信封（缩进 JSON）作为唯一一个 text 内容返回，`ok` 为 false 时 `isError: true`；参数不合 schema 也是 `usage` 信封。交给人的会话不阻塞：`waiting` 错误连同 `next` 立即返回；**`tabcap_handoff_wait {session, timeoutSeconds ≤ 300}`** 每秒查一次 `handoff status`，人一继续就返回，到时仍在等则再返回 `waiting`。
- **`tabcap mcp --print-config <宿主>`**：`claude-code`（`claude mcp add tabcap -- tabcap mcp`）、`cursor`、`codex`（TOML）、`gemini-cli`、`windsurf`、`claude-desktop` 的配置文件位置、条目与宿主自己的添加命令，2026-10-16 对照各家官方文档（windsurf 的页面已跳到 Devin Desktop，`verified: false`）。
- `analyze diff` 末尾的证据包是列表：用法行写成 `[<bundles>...]`。

### 正文导出（0.5-F2）

- **`tabcap net body <r-N | --url u> --file [--pretty]`**：把解码后的正文（按字符集解码、内容编码已解开，与 `--grep` / `--lines` 搜索的文本完全一致；`--pretty` 用同一套断行）写成文件，返回 `{id, url, mime, bytes, lines, pretty, file, scrubbed}`，不内联正文，方便有 shell 的 agent 直接对路径用 `rg` / `grep`。文件在会话打开中的录制的 `exports/bodies/<r-N>[.pretty].<ext>`（扩展名按 MIME：js、json、html、css、txt，其余 bin），无录制则 `<cache>/outputs/bodies/<时间戳>-<r-N>…`；权限 0600；重复调用覆盖。已知秘密值在写入前换成 `<secret:…>`（`scrubbed: true`）；二进制正文原样写出，报 `scrubbed: false` 并附说明。`--file` 不能与 `--grep` / `--lines` / `--at` / `--out` 同用（usage 错误）。

### 命令内搜索（0.5-F）

- **快照过滤**：`snapshot --grep <正则>` 只输出角色、名字、值、状态或描述命中的行，每行连同祖先行、缩进与完整树相同（`--context N` 前后各加 N 个兄弟行，`--max-matches` 默认 50）；`snapshot --css <选择器>` / `--xpath <表达式>` 在每个显示的文档里、在 tabcap 的隔离世界中解析，输出命中元素的行和祖先（没有无障碍行的元素写成 `(no accessible node) <tag#id.class>`）；`snapshot --ref e12 --depth n` 输出某元素下 n 层子树（帧 ref 用它自己的帧）。三者都能与 `--frames` / `--frame`、`--interactive` 组合；ref 与完整快照相同，头部保留，`search` 给出命中数 / 显示数，凡截断都说明怎样拿到更多。正则：JavaScript、`u` 标志、至多 256 字符，无效即 `usage` 错误。
- **`tabcap html <ref | --css 选择器> [--inner | --text | --attrs] [--max-chars 4000]`**：一个元素的 outerHTML、innerHTML、textContent 或属性对象，在隔离世界里读（帧 ref 在其帧里读），先做秘密值替换再截断；`truncated` 与 `chars` 说明是否截断。只写平常的 `cmd` 事件。
- **正文按行搜索**：`net body r-12 --grep <正则> [--context 3] [--max-matches 50]` 在解码后的正文（UTF-8，否则按响应 charset）上逐行搜索，每处命中 `{line, col, text, before, after}`，并给 `lines`、`bytes`、`mime`；`--lines a-b` 取行范围（每次至多 500 行，`note` 给出下一段）；`--at line:col [--context 5]` 取原始正文某位置附近的行（`trace list` 与控制台栈帧给的就是这种位置），`--url <脚本 URL>` 可代替 id 按 URL 找请求。长行以 500 字符窗口返回（`clip`）。
- **`--pretty`**（`net body` / `net grep`）：JavaScript 正文在括号、字符串、模板字面量、正则字面量与注释之外的 `;`、`{`、`}`、`,` 后断行（只插入、不删改的小分词器，所以 `--at` 的位置能映射到美化后的文本）；JSON 正文重新缩进；超过 8 MB 的正文不美化，并在输出里说明。
- **`tabcap net grep <正则> [--resource-types …] [--max-matches 20] [--context 1] [--pretty]`**：在会话录到的全部响应正文上做原文正则搜索：每个请求 `{request, url, resourceType, count, matches}`，至多列 50 个请求（`more`），超过 8 MB 的正文列在 `skipped`。与 `analyze find`（沿解码链追值）不同。
- `net body` 的 id 现在可省（给 id 或 `--url`）；MCP 工具表保留 `html --text`（键名 `textContent`），只有改打印格式的 `--text` / `--json` 才不进表。

### 新增

- **npm 打包脚本**：`bun run npm:pack [--version X] [--targets a,b]` 用 release 二进制在 `dist/npm/` 组装四个平台包（`tabcap-<os>-<cpu>`，改一个常量即为 `@tabcap/<os>-<cpu>`）和 `tabcap` 主包（shim、skill、README），离线 `npm pack` 并写 `SHA256SUMS`，打印发布顺序；本地安装验证与发布步骤见 `packaging/npm/README.md`。不发布任何东西。

## 0.4.0（2026-10-16）

- **帧路径 ref（0.4-I）**：`snapshot` 与 `outline` 的头里列出所有子帧（iframe、`frameset` 的 `frame`，跨源的也算），每帧一行 `f2/f1  <url>  same-origin|cross-origin  depth 2  "<标题>"`，按深度缩进；`f<n>` 的 `n` 是该帧在父文档子帧里按文档顺序的序号（从 1 起），同源 / 跨源相对父帧。JSON 多一个 `frames` 列表。没有子帧的页面输出与以前相同。
- **`snapshot --frames`** 展开每个帧的树，**`snapshot --frame f2/f1`** 只展开该帧及其后代（根文档只在头里）。帧里的元素是**帧路径 ref**：`f<n>/e<m>`，嵌套 `f<n>/f<k>/e<m>`；`--max-chars` 按帧算，超出的帧末尾一行 `(truncated)`。
- **所有带 ref 的命令都认帧 ref**：`click`（含 `--trusted`）、`fill`（含 `--trusted`）、`hover`、`upload`、`where`、`screenshot --ref`、`evaluate --function … --args '[{"ref":"f2/e7"}]'`（函数在那个帧的 window 里跑）。同源帧经标签会话解析，OOPIF 经它自己的会话；可信鼠标输入仍发给标签，坐标按帧的偏移链平移，先在帧里、再在每层的所有者元素处做遮挡检查。帧导航后它的 ref 失效（`stale-ref` 说明是哪一帧）；帧路径写错时告诉你这个编号对应哪个 ref。对帧 ref 的动作输出带 `frame`（也进 `cmd` 结束事件的 `outputSummary`）。
- **帧里的遮挡**：遮挡头也看子帧（标 `in f2`）；带 iframe 的遮挡（iframe 弹层）把 iframe 里的关闭按钮连同帧路径 ref 列进 `close`，可以直接 `click` 关掉。对帧 ref 的 `click` / `fill`，上层文档的遮挡盖住这个帧时也报 `covered`。
- `type` 顺着焦点进帧（同源在页面里，跨源经该帧会话）判断是不是密码框，帧里的密码同样脱敏。
- 靶场加 docs/05 s22 frames（frameset、跨源 iframe 嵌同源帧、关闭按钮在跨源 iframe 里的 iframe 弹层）。

- **侦查档案 v0（0.4-J）`tabcap recon [--text]`** 与离线的 **`tabcap analyze recon <包> [--text]`**（离线时用包里最后一份录到的文档代替页面）：对会话的录制和当前页面写一份档案进证据包，`exports/dossier.json`（schema `tabcap-dossier/0`）与 `exports/dossier.md`（0600，每次覆写）；命令输出两个路径、简短摘要和 `receipt: {dossier: "exports/dossier.json"}`，`cmd` 结束事件的 `outputSummary.receipt` 里也有。不发任何请求。只答四问：
  - **技术栈**：当前页面上每个适配器的 `detect` 结果，加一张 17 条的固定标记表（响应头 `server`、`x-powered-by`、`x-aspnet-version`、`x-aspnetmvc-version`、`x-generator`、`x-runtime`、`x-nextjs-cache`；会话 cookie 名 `JSESSIONID`、`ASP.NET_SessionId`、`PHPSESSID`、`laravel_session`、`csrftoken`、`_<app>_session`、`connect.sid` 等），头的值照录、cookie 只记名字，标【推断】，不猜版本。
  - **数据通道与覆盖率**：请求按方法、路径模板（数字、uuid、长十六进制段写成 `{id}`）、资源类型、正文类别（`json | html | fragment | text | binary | ws | sse`）分组，列条数、首条 `r-N`、状态码、`unreadByPage`、用到的解码步骤和各自承载的页面词数；覆盖率是页面可见文字的词（≥ 4 字符，数字 ≥ 4 位）用 `analyze find` 的精确匹配在录到的响应和收到的 WebSocket 帧里找到的比例，另列至多 20 个没找到的词。
  - **cookie 分类**：按名字列来源（`r-N` 的 `set-cookie`、录制开始时已有、未录到）、有效期、标志、按名字表给的用途（`session`、`csrf`、`consent`、`analytics`、`load-balancer`、`unknown`；【推断】）和 `analyze deps` 给出的 `requiredBy`（分级同 deps）；名字像 csrf 的请求头和字段也列出，来源取 deps。
  - **防护识别**：guard 的挑战识别（类型、`r-N`、交给人的内容）和响应信号（HTML 403、429、`retry-after`、限流头、四个 bot 管理头名），只记名字，【推断】。只识别，不给任何绕过提示。

- **线路层 probe（0.4-W2）`tabcap wire probe --client <export-python 目录> [--port <p>] [--samples <n>] [--text]`**：生成的 Python 客户端和 tabcap 启动的 Chrome for Testing 相比，哪一层网络特征不同，在 127.0.0.1 的本机 TLS echo 上测。客户端新增的 `uv run client.py wire-report --url … --ca … --out …` 发一次 GET（用它自己的 `Session()`，echo 的 CA 经 `SSL_CERT_FILE` 传入，回环地址不走代理）；组件的 `check` 与 `diff` 拿它和浏览器基准比。输出 schema `tabcap-wire/0`：`browser{version, flagsHash, profile, cached}`、`client{library, version}`、`layers[{layer: tls|h2|headers, verdict: same|differs|missing, fields[{field, browser, client}]}]`、`checks[{code, status, message}]`、`labels`（只有一边恢复了 TLS 会话时出 `psk`）与固定的 `note`；`--text` 打表。会话在录制时，四份文档（浏览器报告、客户端报告、check、diff）存 blob，每个不同的层写一条 `finding`（`tool: "wire"`，grade `实测`）。只诊断：说哪层不同，不说站点为什么拒绝，不给改值的办法。
- **`tabcap wire profile [--samples 3] [--port <p>]`**：浏览器基准。在会话里开一个后台标签（tabcap 启动的 CfT，用 tabcap 自己的启动参数），只对这个标签忽略证书错误（`Security.setIgnoreCertificateErrors`），导航到 `https://localhost:<p>/` 再在页面里 `fetch("/fetch")`，各 N 次，然后关掉。组件的 `profile` 把导航与 fetch 分成两种头顺序角色（`http.roles`）；tabcap 加 `tabcap` 段（CfT 版本、本机路径换成记号的启动参数及其 sha256、样本数）。写到 `cache/wire/profiles/cft-<版本>-<os>-<arch>.json`（报告在 `.samples/`），版本与参数哈希不变时 `wire probe` 复用。CfT 155.0.8059.79 的 macOS arm64 画像入库为 `native/wireprint/corpus/chrome/155/macos-arm64/155.0.8059.79.json`；CI 的 e2e 作业把各自采到的上传为 `wire-profile-<os>` 产物。
- **`tabcap wire serve [--port <p>] [--capture-dir <目录>]`**、**`wire version`**、**`wire ca-path`**：单独起 echo（先打印 `{url, port, caPath}`，Ctrl-C 前对每个请求回它自己那条连接的 JSON 报告）、组件的版本 / 路径 / sha256、echo 的测试 CA（`src/wire/certs/`：CA + leaf，SAN 为 localhost、127.0.0.1、probe.test，带 Authority Key Identifier；私钥故意公开，只给 127.0.0.1 用）。
- **echo**（`src/wire/echo.ts`）：`Bun.listen` 前端记录每条连接到 ClientHello 完整为止的字节，整条流原样转给内部 `node:tls`（ALPN h2、http/1.1；不发会话票据：`SSL_OP_NO_TICKET`、`sessionTimeout: 0`，实测 Chrome 因此不带 pre_shared_key）；h2 到首个 HEADERS 块、或 HTTP/1.1 请求头，交给组件的 `report`。
- **组件嵌进 tabcap**：`bun scripts/native.ts build` 交叉编译 `native/dist/<目标>/wireprint[.exe]`（aarch64-macos、x86_64-linux-gnu、aarch64-linux-gnu、x86_64-windows-gnu；ReleaseSafe、strip 后 0.55 / 0.70 / 0.57 / 0.97 MB）；`scripts/release.ts` 在 `bun build --compile` 前先编这四个，四个都嵌进去（tabcap 二进制大约增加 2.8 MB）。运行时把本机那个解到 `cache/native/wireprint-<sha256>/`（0700 / 0755），每次 spawn 前核对 sha256；源码运行用 `native/dist/`，没有就用 Zig 0.16.0 现编。发布工作流装 Zig；CI 的 native 作业编四个并跑本机那个，e2e 作业编本机目标。
- **生成的客户端**：`client.py` 只有一个 `__main__`，子命令 `verify`（动作链模式，用法不变）与 `wire-report`。
- **`native/wireprint` 的变化**（docs/11）：新增 `report --client-hello <文件> [--h2 <文件> | --h1 <文件>] [--alpn] [--sni] [--peer]`（一条连接的报告，即 `profile` / `check` / `diff` 读的形状；也解析 HTTP/1.1 请求头）。退出码：0 成功，1 用法或输入错误（消息在 stderr，stdout 为空），3 `check` 判 INCONSISTENT（JSON 照常在 stdout）；`check` 改为输出 JSON。`profile` 写 `extension_order: randomized | fixed | unknown`（参与判断的样本少于 2 个时为 unknown，此时 `extension_order_randomized` 为 null），`check` 遇 unknown 不判 T4；新增 `--server` / `--server-host-os`。`diff` 对两份报告先归一化（去 GREASE、用扩展集合代替被打乱的顺序、PSK 有无记为 `psk` 标签、每连接的值列进 `ignored`；`--raw` 不归一化），新增 `--json`；SETTINGS 二元组整体比较。删除 OpenSSL 版 `serve`、`openssl` 构建选项、`tools/serve-smoke.sh` 与 `tools/capture.sh`；新增 `-Dstrip`；三个系统跑同一套测试。语料只收 `tabcap wire profile` 采的 Chrome for Testing 画像。

- **信号探针（0.4-G）`tabcap fingerprint probe [--ref <名>] [--text]`**：本浏览器对一张固定字段表（49 个）呈现的值：navigator、UA client hints 及文档列出的高熵 hint、screen、devicePixelRatio、时区、canvas 与 audio 渲染（只留字节的 sha256）、WebGL 参数与扩展、语音列表、30 个常见字体族的 `document.fonts.check`、通知 / 定位权限状态、配色与减弱动效媒体查询。字段名沿用追踪模式信号表的 IDL 写法。tabcap 在 127.0.0.1（端口 0）起自己的自包含探针页，在会话里开一个后台标签加载，用完关掉，会话的当前标签不变；会话在录制时往证据包写一条 `state` 事件 `{what:"env", source:"fingerprint-probe", fields}`。默认输出 JSON 信封（schema `tabcap-fingerprint/0`：`browser`、`ref`、`fields:[{name, value, ref, verdict}]`、`summary`），`--text` 打表。
- **参照值只来自你自己的采集**：`tabcap fingerprint serve [--port <p>] [--once] [--force]` 在 127.0.0.1 上给你自己的浏览器提供探针页，手动打开打印出的地址、点「Save as reference」，写成 `config/fingerprint/refs/<名>.json`（文件 0600、目录 0700；名字 `[a-z0-9-]{1,40}`；同名已存在时不加 `--force` 拒绝）。`fingerprint ref list | show <名> | remove <名>`。不经 CDP 采集，tabcap 不带任何参照值。
- **`--ref <名>`** 加参照列与逐字段结论：`same`、`differs`、`missing`（本浏览器缺、参照里有）、`extra`（本浏览器有、参照里缺）；哈希按字符串比，数组按顺序比。**`tabcap fingerprint diff <包> --ref <名>`** 离线拿包里最后一条 `state` env 事件同样比。
- 只读分析：探针页只读（不写 cookie、不写 storage），输出是字段表，不打分，不给任何改值的建议。会话交给人处理期间 `fingerprint probe` 与 `tab new` 一样等待。
- 结论方向（0.4-G2）：`missing` 改为本浏览器缺、参照里有的字段，`extra` 改为本浏览器有、参照里缺的字段（0.4-G 初版方向相反）。

- **代理池（0.4-D）**：`tabcap proxy add <名> --url <scheme://host:port> [--user <用户>] [--password-stdin] [--bypass "<列表>"]`（密码只从 stdin 或提示符读；`socks5://` / `socks4://` 带用户名一律 `unsupported`，Chrome 只支持无认证 SOCKS）、`proxy list`（名字、scheme、host:port、用户、hasAuth、bypass、状态、上次检查，不列密码）、`proxy remove`、`proxy check <名> [--url <地址>]`。健康检查只打你给的地址（`--url` 或 `config.json` 的 `pool.health.url`），都没有时什么都不连、状态记 `unchecked`。状态：成功一次 `unknown` → `up`，连续 3 次失败 `down`，之后按 1 / 5 / 15 分钟重查，成功一次回 `up`。
- **账号绑代理**：`tabcap account bind <站点>.<用户> --proxy <名>|system|none`、`account list [--site]`（状态、coolUntil、代理、lastUsedAt）、`account set-state <站点>.<用户> active|disabled`。账号状态：`active`；guard 熔断后 `cooling` 30 分钟（交人照常）；24 小时内 2 次登录失败（`--confirm` 放行的密码重试算一次失败）转 `needs-human`，只有 `handoff continue` 或 `account set-state … active` 能清；`disabled`。
- **`tabcap account add <站点> --user <用户> [--password-stdin] [--totp-stdin]`** 给已有站点加第二个（第三个……）账号，`--account auto` 的 `round-robin` / `lru` 才有得选。密码只从提示符或 stdin 读，不走参数，输出里没有；`<站点>.<用户>` 重复报 `conflict`。带 `--totp-stdin`（须同时 `--password-stdin`）时 stdin 两行：密码、TOTP 种子。`account remove <站点>.<用户>` 是它的逆操作（同时清掉已存 cookie 与计数），守护进程里有会话正在用该账号时拒绝。
- **`tabcap proxy set-state <名> active|disabled`** 手动停用代理（分配与轮换跳过、不做检查）或重新启用（回到 `unknown`，失败计数清零，等下一次检查）。输出 `{proxy, from, state}`。
- **`session start <名> --site <站点> [--account <用户>|auto]`**：`auto` 按 `config.json` 的 `pool.strategy`（`fixed` / `round-robin` / `lru`）选。输出与证据包 manifest（`session.proxy`）只记账号名和代理名。绑了代理的账号在 `direct` 模式下有自己的 browser context（Chrome 只拿到 `host:port`），开会话时恢复保存的 cookie，每次 cookie 快照、`session stop` 和守护进程关浏览器前回写。一个池账号同时只开一个会话。
- **代理认证**由守护进程在浏览器会话上经 `Fetch.authRequired` 应答；开着时每条命令输出带 `fetchAuth: "on"`。代理密码、`user:pass@host:port`、`base64(user:pass)`（Chrome 把 `Proxy-Authorization` 报进 `raw/cdp.jsonl`）在所有输出、守护进程日志和证据包里都显示为 `<secret:proxy.<名>>`。
- **出口策略与预算**（`config.json` 的 `pool`）：`egress: {mode: "fixed"|"rotate", rotateOn: "per-session"|"every:<N>requests"|"every:<T>min"}`（是否轮换在开会话时决定）；每账号每小时请求预算 `budget.requestsPerHour` 可选、默认不设，用满后操作页面的命令返回 `guard.budget` 到下一个小时。`guard` 事件的 `budget` 与 `breaker` 开始实际写出（docs/04 §4.2）。
- **下游**：生成的 Python 客户端读 `TABCAP_PROXY_URL`；`replay export-python --proxy-env <文件>` 把证据包账号的代理 URL 写进去（0600，不打印）；`replay check --live` 走同一个代理。
- Chrome for Testing 启动参数加 `--disable-features=…,PreconnectToSearch`：带代理的 context 否则每次导航都经代理发 `CONNECT www.google.com:443`。
- 新错误码 `guard.budget`、`ext.no-context`（ext 模式给不了绑代理账号独立 context，改用 direct）。本地库迁移到第 3 版（只加不改）。

- **`tabcap analyze deps <包> [--session 名] [--request r-N] [--text] [--write-findings]`**：确定性的值流依赖图（schema `tabcap-deps/0`）。对每个请求的每个输入（query 参数、表单与 JSON 正文叶子、`x-*` / `authorization` 头、按名的 cookie），列出在更早事件里找到的来源，按优先级：更早响应的 `set-cookie`、更早响应正文里的值（经 `analyze find` 解码链的 JSON 路径，或 HTML / 文本里的整词）、录到的 `fill` / `type` 值、更早请求发过的同名同值参数、常量、时间戳（`analyze diff` 的分类）。只做精确匹配（去首尾空白，query / 表单值 URL 解码）；来源必须早于这个值第一次被发出。找不到来源的输入标 `computed-in-page`（带 diff 的提示和与它同变的输入），cookie 标 `unrecorded`。`--secret` 填的值只会匹配它的 `<secret:…>` 占位符，输出里不含任何值。与 `find` / `diff` 一样默认输出一个 JSON 信封（`--text` 出文本报告）；证据包只读，`--write-findings` 才追加 `finding` 事件（`tool: "deps"`，从包里重读核对过的精确来源为 `实测`，其余 `推断`）。
- **`tabcap analyze chain <包> [--request r-N] [--session 名] [--text]`**（schema `tabcap-chain/0`）：重现某个请求（默认：最后一个有数据的 xhr / fetch / document 请求）需要的请求，按录制顺序，每步写明给后面提供什么、还要调用方给什么；`todo` 列出 `computed-in-page` / `unrecorded` 输入。
- **`replay export-python` 按动作链生成**（依赖图里有请求取用了更早响应的值时默认开启；`--chain` 强制开，`--no-chain` 与 0.3 输出相同，「变更」里的 uv 打包除外）：来自前一步回复的值成为参数，`computed-in-page` 输入成为默认值 `TODO` 的参数（注释写明提示和同变输入），名字像密码、token 的输入（与 `bundle redact` 同一规则）不写进任何文件；`client.py` 带 `verify()`：`uv run client.py verify --base-url <地址>` 逐步重放动作链，每步按 `replay check` 的比法和录制比，打印 pass / fail 表，有失败退出码非 0。录到的期望值在 `verify_expected.json`（0600；秘密是 `<secret:…>`，运行时从 `TABCAP_SECRET_*` 取；附脱敏副本说明）。调用方在可选的 `todo_inputs.py` 里填 TODO，生成的 README 写明流程。
- 生成的文档保留离线命令自己的 `--session`（只有守护进程共用的 `--session` / `--timeout` 不进用法行）。
- **追踪模式：哪些页面脚本读了哪些浏览器信号（0.4-F）**：`tabcap trace start [--apis <文件>] [--stack 8] [--first-n 20] [--max-hits 500]`、`trace stop`、`trace status`、`trace list [--api <名>] [--script <url>] [--text]`。按会话、显式开启：开了之后会话现有和以后的标签、iframe（含跨进程的）和专用 Worker 都追踪，直到 `trace stop` 或 `session stop`。只读：用调试器断点（`Debugger.setBreakpointOnFunctionCall`，在文档第一条脚本执行前的 `scriptFirstStatement` 暂停里装好）记下哪个脚本哪一行读了哪个 API，页面里不注入、不包装、不改任何东西。断点会让脚本变慢、时间可被察觉——`trace start` 与 `trace status` 的输出写明，开着时每条命令的输出带 `"trace":"on"`。
- 证据包新增事件 **`signal`**（docs/04 §4.1）：每个 (文档, api, 调用位置) 一条，带 `count`、`firstMono` / `lastMono`、每个 (api, 调用位置) 前 `--first-n` 条事件带最多 `--stack` 帧的栈、某 API 在一个文档里命中满 `--max-hits` 次后 `truncated: true`（该文档的这个断点随即撤掉），以及每个文档每个 API 在 tabcap 隔离世界里读一次的 `value`（≤ 1 KB 内联，否则 blob；cookie、storage、表单值写 `"<not-recorded>"`；秘密值替换）。tabcap `evaluate` 引起的读取标 `caller.kind: "tabcap"`。canvas、WebGL 错误、音频上下文的 instrumentation 事件记为 `access: "event"` 的 `signal`。
- `manifest.mode.trace` 为 `false` 或追踪设置（`mechanism`、`apis` = 当前信号表的 sha256、`stack`、`firstN`、`maxHits`）；`manifest.traceWindows` 列出每个追踪窗口开、关时写的 `note` 事件。
- 内置信号表覆盖 navigator、screen、时区、canvas、WebGL、语音列表、字体检查（只有名字；`$TABCAP_HOME/config/signals.json` 或 `--apis` 可替换：最多 500 个名字的 JSON 数组）。浏览器里没有的名字跳过并在 `trace status` 列出；Chrome for Testing 155 上是 `Window.prototype.devicePixelRatio`（全局对象自有的访问器，不在原型链上）。
- 会话等人处理（`waiting`）期间追踪跳过所有调试暂停（`Debugger.setSkipAllPauses`），输出 `"trace":"paused"`；`handoff continue` 恢复。两者都记 `note` 事件。
- 已知盲区：导航开始之后旧文档里的读取记不到；Service Worker 与 Shared Worker 不追踪。

### 页面上的值从哪来（0.4-C）

- **`tabcap where <ref|文字> [--as ref|text] [--top 5] [--text] [--write-findings]`**（schema `tabcap-where/0`）：页面上显示的一个值来自哪个录到的响应。会话的标签页有当前快照时，`e12` 这样的输入是 ref，取该元素的可见文字；其它输入按原样搜（`--as` 可强制）。候选来自三处：经 `analyze find` 解码链的 JSON 值（路径与步骤名和 `find` 一致）、其它文本正文的整段文字、HTML 响应的文本节点（指向响应源码的标签路径选择器）；JSON 候选排在 HTML 候选前。`match` 为 `exact`（去首尾空白后相等，score 1）或 `normalized`（score = 1 / (1 + 用到的规则数)）；同分时更早的请求在前。只读本会话的录制（正在写的包，`net stop` 后是最后一个包），不发任何请求。默认输出 JSON 信封；`--text` 出文本报告；`--write-findings` 追加 `finding` 事件（`tool: "where"`，精确匹配 `实测`，归一化匹配 `推断`）。
- **值归一化**（表驱动，列出所有合理解释及所用规则名，规则少的在前）：`trim`、`nbsp`、`html-entity`、`js-escape`、`fullwidth`、`thousands-sep`（`,` `.` `'` 空格，印度分组 `1,23,456`）、`decimal-comma`、`accounting-negative`（`(1,234.56)`）、`trailing-minus`（`1234.56-`）、`trailing-zeros`、`date-yyyymm`（`2026-09` / `202609` / `09/2026`；完整日期 `20260915` / `15/09/2026` / `09/15/2026`）、`dotted-code`（`1001.01` ↔ `100101`）、`dr-cr`、`empty-zero-null`。两段都 ≤ 12 的 `a/b/YYYY` 日期，只有同页另一个日期能证明日月顺序时才给候选，否则 `ambiguous` 列出两种读法（reason `ambiguous-date`）。只归一到空 / `-` / `—` / `null` / `0` 的查询返回 reason `too-common`。
- 非 UTF-8 的正文按声明的字符集解码（响应的 charset、content-type，否则 HTML `<meta charset>`），例如 GBK；不认识的字符集在无其它命中时给 reason `unsupported-charset`。
- 端到端测试加入靶场场景 s40 locale-numbers（同一份 `/api/rows` 的 en-US、de-DE、fr-FR、en-IN、会计格式五种渲染）。

### HTML 页面里的内嵌状态（0.4-H）

- **解码链新增三个步骤**，解 HTML 文档里携带的状态，`analyze find`、`where`、`analyze deps` 共用（不执行页面脚本，只做有上限的文本扫描）：
  - `script-json`：`<script type="application/json">` 与 `application/ld+json`（含 Next.js `__NEXT_DATA__`），节点地址 `script[<n>]`（n 是这类 script 的文档序号），路径接着写 `script[0].$.props.pageProps.rows[0].amount`。单个超过 4 MiB 不解（`truncated`）；JSON 坏了记 `unparsed`。
  - `inline-assign`：内联脚本里顶层的 `window.X = <字面量>` / `var|let|const X = <字面量>`，字面量是对象或数组，按 JSON 或宽松超集解析（无引号的标识符键、单引号字符串、尾随逗号、`undefined` 当 null），节点地址 `assign[X]`，路径如 `assign[__STATE__].rows[0].amount`。函数调用、表达式、模板字符串、函数体内的赋值不解。每文档最多 64 个、每个字面量最多 1 MiB；解析失败记 `unparsed` 并引用前 80 个字符。
  - `viewstate`：隐藏字段 `__VIEWSTATE`、`__VIEWSTATEGENERATOR`、`__EVENTVALIDATION`、`javax.faces.ViewState`，节点 `viewstate[<name>]` 是表单里的原值（`deps` 因此能把 POST 出去的 viewstate 对回携带它的页面），base64 解开后（每字段最多 2 MiB）是 `{bytes: {length, sha256}, strings}`，`strings` 为至少 4 个字符的可打印 ASCII 串与 UTF-16LE 串，按顺序、去重。不做 .NET LOS / Java 对象图解码。
- 解开的节点认领它的原文，文档其余部分照常按字面量匹配，所以同一个值既在脚本里又显示在表格单元格里时，每处各报一次。`find` 落在节点里的命中带 `node`（步骤、地址、script 的 `id` / `type`）；没解开的节点列在 `searched.embedded`。`where` 把内嵌状态候选和 JSON 候选排在一起，排在页面自身的文本节点前面。
- 端到端测试加入靶场场景 s41 embedded-state。

### 删除

- 删除 0.3 的全部弃用别名，不保留兼容：命令 `tabs`（用 `tab list`）、`tab use`（`tab select`）、`press`（`press-key`）、裸 `console`（`console list`）；参数 `net list --type`（`--resource-types`）、`--limit`（`--page-size`）、`--offset`（`--page-idx`），`screenshot --out`（`--file-path`）、`--full`（`--full-page`）；`net list` 输出字段 `offset`、`limit`、`nextOffset`；`--help` 与生成文档里的「deprecated」行；`tabcap schema --json` 的 `deprecatedFor` / `deprecatedAliases` / `deprecated` 字段。旧名现在报普通的 `unknown command` / `unknown option` 用法错误。`console list --limit`（最后 N 条）和 `dialog --prompt-text`（`--text` 的普通别名）保留。

### 变更

- `net list` 与 `console list` 默认分页：不给分页参数时返回第 0 页、每页 100（还有更多时带 `nextPageIdx`）；`--page-size 0` 返回全部（原来的默认行为）。`--page-size 0` 同时给大于 0 的 `--page-idx` 报用法错误。
- 会话等待人接手（hand-off）期间，`resize` 和 `emulate` 与其它作用于页面的命令一样返回 `waiting` 错误。
- 输出全部改为英文：`waiting` 错误的 `next`（"complete the verification in the browser, then run `tabcap handoff continue`"）、DOM 点击与 `type --insert` 的 `incomplete event sequence: …` 警告、`bundle is not finished: …` 警告与 `analyze find` / `diff` 文本报告里的 `(unfinished)`、snapshot / outline 头部（`overlays` / `detected` / `popups`，遮挡行改英文，名字用 ASCII 引号）、`covered` 错误、`replay export-python` 生成包的 README（模板与动作链一节）。只有证据等级（`实测` / `推断` / `待验` / `人确认`，证据包格式里的值）保持不变。
- 脱敏规则 `default@2`（`bundle redact`、HAR 导出，以及 `replay export-python`、`analyze deps` 共用的敏感名规则）：`pass`、`pwd` 作为名字的一段时算敏感（`pass`、`user_pass`、`userPass`、`login-pwd`、`Pwd2`；`bypass`、`passport`、`compass`、`passenger` 不算）；原有子串（`passw`、`token` …）照旧。脱敏副本记 `"rules": "default@2"`。修复 `replay export-python --no-chain` 把名为 `pass` 的登录字段的录制值写进 `client.py`。
- `--help`、生成的命令参考、SKILL.md 与 README 里的示例站点名改为 `example`（原为 `shop`）。
- 生成的客户端用 `uv run` 运行：`uv run client.py verify --base-url <地址>`、`TABCAP_REPLAY=<地址> uv run --group test pytest`（[uv](https://docs.astral.sh/uv/) 首次运行时按 `pyproject.toml` 建 `.venv/`；README、`client.py` 头部注释与 SKILL.md 都这样写，不再出现 `pip install` 或 `python client.py`）。`pyproject.toml` 依赖 `httpx[http2]`，客户端用 `httpx.Client(http2=True)`（只在 TLS 协商出 HTTP/2 时用；明文 `http://`，例如 `replay serve`，仍是 HTTP/1.x）；pytest 从 `test` extra 移到 PEP 735 的 `test` dependency group；输出目录没有 `.gitignore` 时写一个（`.venv/`、`__pycache__/`）。测试与 CI 用 uv：所有 Python 运行都经 uv 离线进行，每个生成包各自一个 `.venv`；CI 每个 job 预热 uv 缓存，在 CI 里缺 uv 或缓存时 Python 测试失败而不是跳过。

### 修复

- `analyze deps`（以及 `analyze chain`、`replay export-python`）比两个请求的先后改用单调钟（`timing.start`、`timing.responseStart`、body 的 `mono`），只有一方没有单调钟时才退回墙钟。每个请求的墙钟 `ts` 各以自己的 CDP `wallTime` 为锚，下一个请求前约 2 ms 读完的响应在墙钟上可能排到它后面，于是从该响应取的令牌（s07 从登录 body 取的 `x-csrf`）丢了来源、显示成 `computed-in-page`（Windows CI 上出现过一次）。
- `emulate --network-conditions` 在未录制的会话上也真正限速：Chrome 只在 Network 域开启时施加节流，所以模拟了网络预设的标签会保持 Network 开启，直到之后的 `emulate` 清除它；`wait --idle` 与 `net stop` 不再在底下把它关掉。靶场实测：「Slow 3G」下 300 KB 的 fetch 约 8 s（按预设 50000 B/s 算下界 6 s），修复前不录制时只要 1 ms；`wait --idle` 与 `net stop` 之后仍然限速。

### 原生线路层指纹组件（0.4-W1）

- **`native/wireprint/`**（Zig 0.16.0，与仓库其余部分同为 Apache-2.0）：线路层指纹工具作为原生组件并入本仓库。读 pcap、原始 TLS record 与 HTTP/2 客户端流，算 ClientHello 全字段、JA3、JA4（`_r` / `_o` / `_ro`）、HTTP/2 的 SETTINGS / WINDOW_UPDATE / 伪头顺序、HPACK 解码后的头与 Akamai 串，另有画像组装、跨层一致性检查与按层分组的 diff。`bun run test:native` 跑它的离线测试（`zig build test -Dopenssl=false`），`bun run fmt:native` 格式化；CI 在 Linux、Windows、macOS 上构建，并交叉编译 darwin-arm64、linux-x64、linux-arm64、windows-x64（暂不进发布包）。只构建 `-Dopenssl=false`：原来的 `serve` 回显服务器留在源码里但不编译。JA4H / JA4T 代码与 `-Dja4plus` 选项在并入前删除。浏览器画像（`corpus/`）今后只来自 tabcap 集成的 Chrome for Testing 版本。第三方声明（JA3、JA4、RFC 7541 表）见 NOTICE。

## 0.3.0（2026-10-16）

- **命令名对齐 Chrome DevTools MCP**（docs/08 §5）：`press` → `press-key`，`tabs` / `tab use` → `tab list` / `tab select`，`console` → `console list`（新增 `--types`、`--page-size`、`--page-idx`、`--include-stack-traces`，`--level`、`--limit` 保留）与 `console show <msgid>`；`net list --type / --limit / --offset` → `--resource-types / --page-size / --page-idx`（页码语义，`nextPageIdx`；不给分页参数时返回全部匹配，给了默认每页 100；默认仍藏失败与 `data:`，`--all` 全列）；`screenshot --out / --full` → `--file-path / --full-page`，新增 `--format png|jpeg|webp`、`--quality`、`--ref`；`snapshot` 新增 `--verbose`、`--file-path`；`type --submit-key`；`click --dbl-click`；`dialog --prompt-text`；`wait --text` 可重复（任一命中），并在所有帧里找；`evaluate --function` / `--args`；`reload --ignore-cache`。旧名保留到 0.4，`--help` 标为弃用；`net list` 输出仍带旧的 `offset` / `limit` / `nextOffset` 字段一版。
- **新命令**：`tab new <url> [--background]`（默认后台）；`tab select --bring-to-front`（焦点阶梯第三级，明确要求时才拉前台并在输出里说明）；`hover <ref>`（可信鼠标路径，标签不绘制时报新错误码 `not-painted`）；`resize <宽> <高>`；`upload <ref> <文件…>`（`DOM.setFileInputFiles`，按钮打开文件框时拦截并回答）；`emulate`（视口、UA、配色、网络与 CPU 节流、地理位置；每次调用替换之前全部设置）。
- **动作后等待**：`click`、`hover`、`fill`、`type`、`press-key`、`navigate`、`tab new`、`go`、`reload` 返回前等动作引起的导航完成，再等 DOM 100 ms 无变化（各 3 s 上限，随节流放大）；输出 `wait` 字段；`--no-wait` 跳过。交互命令加 `--snapshot` 顺手带回新快照。录制时命令窗口相应变长。
- **借用 chrome-devtools-mcp（Apache-2.0，Google）**：分页函数与「Showing a-b of n (Page x of y).」文案、网络列表 URL 截断 255 与正文预览 10000 字、快照行格式（状态写成裸词 `checked focused`、其它属性 `attr="value"`，ref 仍是 `[e12]`）、emulate 参数集与语义；网络预设取自 Puppeteer。见 NOTICE。
- **skill 改为 agentskills.io 布局**：`skills/tabcap/SKILL.md`（英文，name 与目录同名，description 触发词前置、≤ 400 字，`compatibility` 写明需另装 tabcap 与 Chrome for Testing）+ 生成的 `references/commands.md`；单测里有本地校验器（`scripts/validate-skill.ts`，代替无法离线安装的 `skills-ref validate`）。
- **英文优先**：README、SKILL.md、CHANGELOG、`--help` 以英文为主，中文版并行（`README.zh-CN.md`、本文件）。

- **站点与账号库**：`tabcap site add <名> --url <入口> --user <账号> [--domains a,b]`，密码在提示符下输入或 `--password-stdin` 从管道读，不接受命令行参数；`tabcap site list` 只列站点名、入口、域名、账号名和引用，不列密码；`tabcap site remove`。库是 `~/.config/tabcap/state.db`（bun:sqlite，明文，文件 0600、目录 0700，权限更宽时守护进程拒绝启动）。
- **用引用填凭据**：`tabcap fill <ref> --secret <站点>.password|username`，由守护进程取值填入。库里的密码在所有命令输出、守护进程日志、`snapshot` / `evaluate` 结果和证据包的 `cmd` 事件里都显示为 `<secret:<站点>.password>`；只有登录请求本身的正文原样进包，HAR 导出和 `bundle redact` 会把它打码。`tabcap session start <名> --site <站点>` 把站点绑到会话，证据包 manifest 记 `session.site` / `session.account`。
- **登录限次**：同一会话对同一站点第二次 `fill --secret …password` 返回 `guard.login-limit`，不碰页面；`--confirm` 放行。每次判定写一条 `guard` 事件。
- **撞上验证页交给人**：录制中某个接口或页面返回 HTML 的 403 时，会话进入 `waiting`（带原因和截图路径），之后操作页面的命令都返回 `waiting`，直到人处理完、执行 `tabcap handoff continue`；`tabcap handoff status` 查看状态。证据包里有 `guard`（breaker）与 `handoff`（waiting / resumed）事件。目前只认这一种挑战，且要在 `net start` 录制时才生效。
- **外部处理程序接口**：`~/.config/tabcap/plugins/<名>/manifest.json` 描述一个独立进程的处理程序（stdin / stdout 各一个 JSON，任何语言都行），`tabcap plugin list | enable | disable`。撞上挑战时先问已启用的处理程序，给出答案就恢复会话并把答案交给 AI，否则交给人；每次调用作为一对 `cmd` 事件（actor `system`，输入输出已替换秘密值）进包。tabcap 本身不带任何处理程序。
- 新错误码 `waiting`、`guard.login-limit`；错误信封可以带额外字段（`waiting` 带 `state`、`reason`、`screenshot`）。
- **离线回放服务器**：`tabcap replay serve <包> [--port 4500]` 只监听本机回环，按「方法 + 路径 + 排序后的 query + 请求体 sha256」匹配，吐出录到的状态码、响应头（去掉逐跳头、`content-length`、`content-encoding`，`set-cookie` 原样）和正文；同一个键录了几次就按录制顺序轮流给（分页式），响应头 `x-tabcap-replay: r-12;n=2` 说明给的是哪条；没取到正文的给录到的状态码和空正文，并带 `x-tabcap-replay-missing`；同源的 `location` 改成路径，跳转留在回放服务器上。匹配不上返回 404，JSON 里列出最接近的至多 3 条录制和哪几部分对不上。`--strict <头>` 把指定请求头也算进匹配，`--match-cookies` 把 cookie 也算进去。
- **逐项比对**：`tabcap replay check <包> --against <地址>` 把录到的请求重发一遍，比状态码、选定的响应头和正文（JSON 逐路径、文本全等、二进制比哈希），打印对比表（`--json` 出信封），有差异退出码 1。默认只允许本机回环；非回环要 `--live`，且要求库里有这个站点、域名对得上，按站点计数，默认每 2 秒最多 1 个请求（`--rate` 调整）。
- **导出会话**：`tabcap replay session <包> -o storage-state.json` 把包里最近一次 cookie 快照写成 Playwright storageState 格式（包里没有时可用 `--site` 取库里存的会话），文件 0600，输出里不显示 cookie 值。
- **生成 Python 客户端**：`tabcap replay export-python <包> -o <目录>` 生成 httpx 客户端（每个请求组一个函数，常量写死，会话值从 storageState 取，时间戳调用时生成，每次都变的参数作为函数参数，响应字段写成 `TypedDict`）、fixtures、对着 `replay serve` 跑的 pytest 和中文 README。签名类参数、加密请求体不还原，对应函数抛 `NotImplementedError`（标 `TODO: computed in the page; see docs/03 §6`）。
- **cookie 快照进包**：录制时每个标签在 `net start`、每次页面导航（`navigation` 类）和 `net stop` 各写一条 `state` 事件（`what: "cookies"`，正文是 CDP `Network.getCookies` 原样数组，存成 blob，事件里只有 `origin`、`count`、`reason`），`tabcap replay session <包>` 在真实录制上可用了。
- **站点会话存库**：用 `--site` 开的会话在 `tabcap session stop` 和 `tabcap handoff continue` 时把该站点的 cookie 存进本地库（`sessions` 表），输出只给条数；`tabcap replay session --site <站点> -o …` 不要包也能导出。库里存的 cookie 值（8 个字符以上）和密码一样，在所有输出里替换成 `<secret:<站点>.cookie.<名>>`。
- **回放按主机区分**：包里录了不止一个主机时，`replay serve` 的匹配键加上主机：请求的 `Host` 头写成录到的某个主机（如 `curl -H 'Host: api.example.test' …`）就只匹配那个主机的录制；其他 `Host` 照旧按方法、路径、query、请求体匹配。`--json` 的 `match.host` 和 `routes[].host` 说明是否启用。
- **修复截图与收尾顺序**：后台标签刚渲染完新内容时 Chrome 偶尔对截图直接回「Unable to capture screenshot」，验证墙的 `waiting` 截图因此为空（0.3-A 以来端到端 s15 的偶发失败）；现在这种情况改用焦点仿真截图（与截到纯色图时相同）。录制停止或导航时一并收尾的未完成请求按开始顺序写入证据包（此前并行写，顺序可能颠倒）。
- **修复**：请求 `timing.responseStart` 改取 CDP ResourceTiming（与 `end` 同一时钟），不再晚于 `end`；`bundle export har` 写出的 HAR 与 salt 文件改为 0600；`tabcap type` 在焦点元素已被移除或重渲染（焦点落回 `<body>`）时返回 `stale-ref`，不再静默什么都没输入。
- **不再认 `BBL_*` 环境变量**：0.2.x 对旧名的回退删除，只认 `TABCAP_HOME`、`TABCAP_CHROME`、`TABCAP_SESSION`、`TABCAP_LOG` 等 `TABCAP_*`。
- 证据包读取时保留请求的 `postDataMissing`；本地库升到 schema 2（`guard_counters` 加请求计数，供 `replay check --live` 限速）。
- **可信点击**：`tabcap click <ref> --trusted` 现在像真人一样点：开焦点仿真、确认标签在绘制后，鼠标沿一条 100–400 ms 的路径移到元素中心（终点精确），按下，停 50–140 ms，抬起；pointer / mouse 两族事件由 Chrome 生成，全部 `isTrusted:true`，按下时 `pressure` 0.5。输出新增 `eventShape:"full"`、`trajectory`（起点、终点、点数、时长）、`pressGapMs`。标签确认不了在绘制（隐藏且不出帧）时不发任何鼠标移动，改用 DOM 点击并标 `degraded:"not-painted"`；某次移动无响应报新错误码 `move-timeout`，不按下。任何失败都不自动重试，`not-delivered` 的提示不再建议「再试一次」。
- **默认点击不变，但标明残缺**：不带 `--trusted` 的 `click` 仍是 DOM `el.click()`，输出新增 `eventShape:"incomplete"` 和「事件序残缺」警告（只有一个 `isTrusted:false` 的 `click`，没有 pointer / mouse 事件）。
- **逐键输入**：`tabcap type <文字> --trusted` 每个字符按一次键（keydown、keypress、beforeinput、input、keyup，全部可信），美式键盘上没有的字符（中文、emoji）逐字插入；`--delay <毫秒>` 设字符间隔，默认 0。默认的 `type` 和新的 `--insert` 仍是一次插入整段，输出 `eventShape:"insert"` 和「事件序残缺」警告。
- **页面不读的响应也能及时看到**：页面拿到响应却从不读正文时，Chrome 不发完成事件，以前要到 `net stop` 才写进证据包；现在响应到达 1 秒后若已经拦截到完整正文，就写成 `finished`，带 `unreadByPage: true`、`bodySource: "fetch"`、没有结束时间，录制中 `net list` / `net show` / `net wait` 和 guard 都能看到。
- **Linux x64 与 Windows x64 代码路径**（macOS 行为不变）。Linux：默认目录遵循 XDG（`$XDG_CONFIG_HOME/tabcap`、`$XDG_CACHE_HOME/tabcap`、`$XDG_DATA_HOME/tabcap`；未设置时仍是 `~/.config` / `~/.cache` / `~/.local/share`），`tabcap setup` 用 `unzip` 解压，没有 `unzip` 时用 `bsdtar`。Windows：全部放在 `%LOCALAPPDATA%\tabcap\{config,cache,data}`；守护进程监听 127.0.0.1 的随机端口，每次启动生成新的 bearer 令牌，端口与令牌写进 `config\daemon.json`，CLI 从这里读（令牌不进日志、不进命令行、不出现在 `daemon status` 里；不带令牌的请求回 401）；`tabcap setup` 下载 `win64` 版，用 PowerShell `Expand-Archive` 解压，并读二进制的版本资源核对（Windows 上 `chrome.exe --version` 不输出任何东西）；本地库与插件目录在 Windows 上不做权限检查（没有 POSIX 权限位，文件沿用 `%LOCALAPPDATA%` 的用户默认 ACL）；前台归还（macOS 的 `osascript`）跳过并记一行日志。
- **Linux：后台标签上的可信输入、导航时的 cookie 快照**。Linux 上被焦点仿真变成 visible 的后台标签没有任何东西绘制它，出过几帧有变化的画面后 Chrome 只给它每秒 1 帧，`click --trusted` / `hover` 的鼠标移动因此超时（`move-timeout`）。绘制检查现在同时量帧率；帧慢时开一个极小的 screencast，从第一条移动之前保持到松开之后，输出里标明（`paint: {frameMs, held: "screencast"}`）。macOS 的标签全速出帧，不受影响。`nav` 的 cookie 快照改为带提交的 URL 调 `Network.getCookies`：不带 `urls` 时 Chrome 可能按还没记下新 URL 的框架树作答，返回空。
- `tabcap daemon status` 新增 `listener`（`unix` 或 `tcp`），Windows 上另有 `port`、`socket` 为 null。`tabcap setup --platform` 接受 `win64`。
- **二进制与发布包**：`bun run release` 用 Bun 交叉编译出 `tabcap-darwin-arm64`、`tabcap-linux-x64`、`tabcap-linux-arm64`、`tabcap-windows-x64.exe`，各打成 `tabcap-v<版本>-<平台>.tar.gz`（Windows 为 `.zip`），内含二进制、skill、`README.md` 与 `README.zh-CN.md`（只含快速开始）、`LICENSE`、`NOTICE`；每个包一个 `.sha256`，另有一份 `SHA256SUMS`。
- **CI**（GitHub Actions）：Linux、Windows、macOS 上跑单元测试、类型检查、skill 校验；Linux（Xvfb）与 Windows 上跑端到端测试，Chrome for Testing 由 `tabcap setup` 下载并按版本缓存；打 `v*` 标签时在对应 runner 上构建四个包（linux-arm64 为交叉编译）并建草稿 release，从不自动发布。
- **打包模板**放在 `packaging/`（不发布到任何地方）：Homebrew formula（macOS arm64）、npm 包装包（每个平台一个可选依赖，启动垫片不带安装脚本）、Scoop 清单。
- 仓库在所有系统上都以 LF 换行检出（`.gitattributes`）；夹具与生成文档按字节比对。

## 0.2.0（2026-10-15）

- **改名**：`bbl` 改叫 `tabcap`。二进制、skill（`skill/tabcap/`）、默认目录（`~/.config/tabcap`、`~/.cache/tabcap`、`~/.local/share/tabcap`）、环境变量（`TABCAP_HOME`、`TABCAP_CHROME`、`TABCAP_SESSION`、`TABCAP_LOG`）都用新名。0.2.x 仍认旧的 `BBL_*` 环境变量，0.3 删除。旧目录不自动迁移：重跑一次 `tabcap setup`，或者把 `~/.config/bbl` 等改名。
- **等待**：`tabcap wait --text | --selector | --url | --idle | --fn` 等页面条件；`tabcap net wait --url` 等某个接口带正文回来。超时的报错写明还差什么。
- **控制台**：`tabcap console` 看标签页的 console 和未捕获异常（带短栈），不录制也保留最近 500 条。
- **录制**：WebSocket 帧进包（`net list --kind ws`、`net body r-12:34`）；console 进包；每条命令记成开始 / 结束一对事件；没收到响应的请求 `status` 记 null。
- **离线分析**：`tabcap analyze find <包> <文字>` 找文字出现在哪个请求、帧或控制台行，自动走 base64、gzip、URL 编码、JSON 转义等解码链，找不到时列出疑似加密的响应（熵阈值按长度分档）；`tabcap analyze diff <包1> <包2>` 对比几次录制里的参数：常量、会话值、时间戳、每次都变。`--save` 把结论写回包里。
- **命令表导出**：`tabcap schema --json` 输出全部命令、参数、选项的类型和默认值、说明和例子，方便接到别的 agent 或工具。
- HAR 导出不含 `cmd`、`console` 事件，在 `dropped` 里列出数目。

试用反馈修复（同属 0.2.0）：

- **弹窗不再抢前台**：页面 `window.open` 开出的窗口或前台标签会让 Chrome 跑到 macOS 最前面，tabcap 发现后把前台还给原来的应用（`tabcap browser status` 的 `popupFocus` 有计数）。你本人正在用这个浏览器时不会去抢。
- **能操作弹窗**：弹窗出现在 `tabcap tabs` 里（`reason: popup`、`opener`），opener 是本会话自己开的标签时弹窗也归本会话所有，`session stop` 会一并关掉。所有针对标签的命令都能加 `--tab t2`；`tabcap tab use t2` 切换当前标签。
- **不再假成功**：元素被页面重渲染替换后，旧 ref 的 `click` / `fill` 报 `stale-ref`（提示重新 snapshot），不再报「点了」却什么也没发生。
- **`tabcap net show <id>`**：一个请求的全部细节——请求头、请求体（超过 2 KB 给文件路径加前 2 KB）、响应头、正文路径、耗时、发起位置 `url:行:列`、所属导航和标签、结果；`r-12:34` 显示一个 WebSocket 帧。
- **`net list` 不再被噪音淹没**：默认隐藏失败请求（例如页面扫端口）和 `data:` 地址，但一定给出 `total`、`shown`、`hidden: {failed, data}` 计数；`--failed` 只看失败的，`--all` 全看；新增 `--host`、`--status 4xx`、`--method`、`--tab`、`--since c-12`、`--limit`（默认 100）、`--offset` 分页。
- **`net wait` 回看到上一个动作**：从最近一条动作命令（navigate / click / fill / type / press / go / reload / evaluate）开始算，`click → wait --text → net wait` 不再超时；`--since start` 看整个录制，`--fresh` 只等新的；超时提示里列出更早已完成的匹配。录制时动作命令返回自己的 `cmd` 编号。
- **`find` 先给可点的**：可点击的命中排在前面；自定义复选框、`div role=none` 按钮这类控件，`find` 会找到真正带点击监听或手形光标的元素，点它的 `clickable` ref 即可。
- **`evaluate` 返回 Promise 时**报 `needs-await`（提示加 `--await`），不再返回 `{}`。
- `tabcap net list --help` 这类两级帮助、`tabcap net --help` 列子命令；新增 `tabcap --version`。
- `tabcap setup` 会清掉上次中断留下的半截下载，下载失败也不留临时目录。
- 证据包文件权限收紧为仅本人可读（文件 0600、目录 0700）；事件的 `actor` 默认记为 `ai`，不再把导航之后页面自己发的请求记成 `human`。

## 0.1.0（2026-10-15）

以 `bbl` 为名首发，只测过 macOS arm64。守护进程自己管一份 Chrome for Testing（独立 profile），后台标签操作、不抢前台；`navigate`、`snapshot`（带 ref 的无障碍树）、`find`、`click`、`fill`、`type`、`press`、`evaluate`、`screenshot`、`dialog`、会话与标签管理；`net start | stop | list | body` 把网络请求连正文录进包；`bundle export har | import har | redact | info`；Claude Code skill。
