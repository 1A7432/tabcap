# 13 · 与 mitmproxy / Burp 互通

作者 10-16 定：不做 Burp 兼容的运行时；本页只写怎么串联、怎么把抓包导进来、decode 钩子和 mitmproxy addon 的对应。流量导入先保 mitmproxy，Burp 后做。结论标记：【实测】本页作者自己跑过（2026-10-16，mitmproxy 12.2.3，Chrome for Testing 155，macOS arm64）；【推断】；【待验】没跑。所有请求只发给本地靶场（`test/e2e/site.ts`）。

## 1. 串联：浏览器 → 代理 → 站点

```
tabcap 的 Chrome for Testing ──► mitmproxy / Burp (127.0.0.1:8080) ──► 站点
        └─ CDP 管道，录制不经过代理
```

### 1.1 命令与 Chrome 参数

代理是浏览器级的，写在 `browser start` 上，不是 `session start`（`session start` 没有 `--proxy`）：

```
tabcap browser start --proxy http://127.0.0.1:8080
```

`--proxy` 的取值：`system`（默认，什么都不传）、`none`、`http(s)://` / `socks4|5://` URL 或 `host:port`。`config.json` 的 `proxy` 是它的默认值。tabcap 起 Chrome 时传的参数（`src/daemon/transport/direct/launcher.ts` 的 `buildArgs`）里和网络有关的：

| `--proxy` | 加的参数 |
|---|---|
| `system` | 无 |
| `none` | `--proxy-server=127.0.0.1:1 --proxy-bypass-list=127.0.0.1;localhost`（黑洞，外连全断） |
| URL | `--proxy-server=<URL> --proxy-bypass-list=<-loopback>`（0.6-N 起；loopback 也过代理） |

其余固定参数：`--disable-background-networking`、`--disable-component-update`、`--disable-sync`、`--metrics-recording-only`、`--disable-field-trial-config`、`--disable-features=…,HttpsUpgrades,PreconnectToSearch,…`（完整表在 launcher.ts）。没有 `--ignore-certificate-errors`，也没有任何证书相关参数。账号绑了池代理（`proxy add` / `account bind`）走另一条路：那个账号的 browser context 自带 `proxyServer`，见 docs/07 §4 第 6 条，本页不展开。

### 1.2 loopback 目标也过代理【实测】

Chrome 默认不对 `localhost`、`127.0.0.1`、`[::1]` 走代理，除非 bypass 列表写 `<-loopback>`。0.6-M 的实测发现 tabcap 的 URL 模式没写这一项，本机靶场的流量不经过代理（历史结论，已改）。0.6-N 起 `browser start --proxy <url>` 一并传 `--proxy-bypass-list=<-loopback>`，账号池的 context 级代理（`proxyServer`）没有自带 bypass 列表时同样带 `proxyBypassList: "<-loopback>"`；`--proxy system` 与 `--proxy none` 不变（`none` 仍放行 127.0.0.1 / localhost）。实测（`test/e2e/v06n.e2e.test.ts`，代理是 `test/e2e/site.ts` 的 `startProxySite()`，以它自己的日志为准）：`tabcap browser start --proxy <代理>` 后依次 `navigate`：

| 目标 | 代理是否看到 |
|---|---|
| `http://127.0.0.1:<port>/plain` | 有（并转发到靶场，靶场访问日志有 `GET /plain`） |
| `http://localhost:<port>/plain` | 有 |
| `http://[::1]:<port>/plain` | 有（只看日志，靶场不在 `[::1]` 上） |

换成 `--proxy none` 再 `navigate` 同一地址：代理日志不增加，靶场直接收到请求。因此靶场可以直接用 127.0.0.1 试串联，不需要把靶场换成非 loopback 的名字；守护进程自己的 CDP 连接是管道，不受影响（docs/07 §4 第 6 条）。mitmproxy 侧照旧：

```
uvx --from mitmproxy mitmdump -p 18081
tabcap browser start --proxy http://127.0.0.1:18081
tabcap navigate http://127.0.0.1:<port>/s06
```

0.6-M 用非 loopback 名字绕过时碰到的两个坑【实测】：

- `range.test` 是 http 且不是 loopback，所以页面**不是 secure context**：`window.isSecureContext` 为 `false`，`crypto.subtle` 是 `undefined`。靶场的 s06 页用 `crypto.subtle` 算签名，页面脚本在这里中途停止，不会发 `/api/search`。要走完整流程用不依赖 secure context 的页面（s07 登录页只用 `fetch`）。
- 用 curl 从命令行打代理时，环境里的 `no_proxy=127.0.0.1,…` 会让 `curl -x` 也跳过代理；加 `--noproxy ''`。

### 1.3 HTTPS

mitmproxy / Burp 对 https 要做中间人，Chrome 必须信任代理的 CA。【待验】本节没跑：

1. 先只在 http 靶场上验证串联（1.2），https 留到真有需要。
2. 取 CA：mitmproxy 在 `~/.mitmproxy/mitmproxy-ca-cert.pem`（第一次运行后生成）；Burp 从 `http://burp/cert` 下载。
3. 把 CA 装进 Chrome for Testing 信任的地方。macOS 上 Chrome 用系统信任库，装进登录钥匙串并设为「始终信任」会影响本机所有程序，用完要删；Linux 上是 NSS 库（`~/.pki/nssdb`，不在 tabcap 的 profile 目录里）。tabcap 没有 `--ignore-certificate-errors`。
4. 用完把 CA 从信任里删掉。

### 1.4 串联后各自看到什么

- tabcap 仍然**全部录得到**：录制走 CDP 管道，在浏览器一侧看请求，和有没有代理无关。bundle 里的请求、响应、时序、`initiator`、DOM、截图都在。代理看不到的 `initiator`、渲染结果、人的操作，tabcap 有。
- 代理多出来的是**线上的另一个视角**：浏览器发出之后、站点收到之前的原始字节，TLS 之后的重发 / 改包 / 断点（Burp Repeater / Intercept，mitmproxy 的 `i` 过滤与断点），以及不经浏览器的其他客户端流量。也能在代理里改包再放，tabcap 录到的是浏览器发出的版本，代理改过的部分 tabcap 看不到。
- 两边的请求一一对应不是自动的；对照靠 URL + 时间，或用 §2 把代理的 HAR 导进来 `analyze diff`。

## 2. 导入：mitmproxy HAR → bundle

### 2.1 流程【实测】

```
uvx --from mitmproxy mitmdump --set hardump=./mitm.har -p 18080     # 退出（Ctrl-C）时才写文件
# … 经 127.0.0.1:18080 做你的操作 …
tabcap bundle import har ./mitm.har -o ./mitm-bundle
tabcap analyze find ./mitm-bundle 'data-ok'
tabcap analyze deps ./mitm-bundle --text
tabcap analyze diff ./b1 ./b2 --text
tabcap analyze recon ./mitm-bundle --text
```

`hardump` 在进程退出时才落盘（日志 `HAR file saved`）。样本 `test/fixtures/har/mitmproxy-range.har`：靶场 s06 页加 `/api/search`、s07 登录（`/api/login` POST、`/api/data` POST），5 条请求，用 curl 经 mitmdump 发。登录密码在文件里出现两次（`postData.text` 与 `postData.params[].value`），入库前两处都换成 `<redacted>`，其余原样（所以 `Content-Length: 51` 与 `postData.text` 的实际长度不再一致）。mitmproxy 的 HAR 含明文 cookie / token：导入后要给别人看就先 `tabcap bundle redact`。

实测结果：

| 命令 | 在导入包上 |
|---|---|
| `bundle import har` | 5 requests，`lossy` 为 `actor tab cmd mono cdp headersSource redirect initiator`；5 条的 `type` 是 content-type 推的（`document` 2、`xhr` 3），`typeInferred` 全是 `content-type`（curl 不发 `sec-fetch-*`） |
| `analyze find` | 命中 `data-ok`（`r-5` 响应 `$.data`） |
| `analyze deps` | 4 条边：`x-csrf` ← `r-4` 响应 `$.csrf`、`sid` ← `r-4` 的 `set-cookie`，`password` 标 `sensitive-name` |
| `analyze diff`（同一文件导两份） | 按 `method + path` 归组，常量 / 变化参数照常给出 |
| `analyze recon` | 数据通道表、cookie 表（`sid` 来源 `set-cookie r-4`）都有；`page` 与技术栈为空 |
| `replay export-python` | 0.6-N 起能生成客户端（0.6-M 时失败：`no request to generate a client for`，因为 `type` 全是 `other`） |

0.6-M 时 `replay export-python` 失败的原因【实测】：它只用 `xhr` / `fetch` / `document` 类型的请求，而 mitmproxy 的 HAR 没有 `_resourceType`，导入后每条的 `type` 都是 `other`。0.6-N 起导入按 docs/04 §9.2 的固定表推类型（`_resourceType` → `sec-fetch-dest` → 响应 `content-type`），推出来的标 `typeInferred`，`bundle info` 计数；这份样本推出 `document` 2 条、`xhr` 3 条，`replay export-python` 因此有请求可生成（`test/unit/har-import-type-timing.test.ts`）。

### 2.2 字段丢失表（以 `test/unit/har-mitmproxy.test.ts` 的 DROPPED 为准）

这张表是对那个文件的逐字段结果，测试会逐项核对（文件里每个字段不是在「保留」就是在「丢弃」）。

| 位置 | 丢弃的字段 | 后果 |
|---|---|---|
| `log` | `version`、`creator.comment`、空的 `pages[]` | 没有页面，`nav` 全是 `null`，包里没有 `nav` 事件 |
| `request` | `httpVersion`、`cookies[]`、`queryString[]`、`headersSize`、`bodySize` | 无影响：cookie 在 `Cookie` 头里、query 在 URL 里；协议取响应的 `httpVersion` |
| `request.postData` | `mimeType`、`params[]` | body 以 `text` 原文存；类型看请求头 `Content-Type` |
| `response` | `cookies[]`、`headersSize`、`bodySize`、`redirectURL` | `Set-Cookie` 仍在响应头里；`redirectURL` 丢了，重定向链靠 `Location` 头 |
| `response.content` | `size`、`compression` | 大小取实际字节数 |

保留并进入 bundle 的：`startedDateTime`、`time`、`timings.{connect,ssl,send,wait,receive}`（0.6-N 起，映射见 docs/04 §9.2；样本里没有 `blocked`、`dns`，按未知处理，导出时 `blocked` 读回 `0`、`dns` 读回 `-1`）、`method`、`url`、请求 / 响应头（名字转小写）、`postData.text`、`status`、`statusText`、响应 `httpVersion`、`content.mimeType`、`content.text`、`serverIPAddress`（`remote.ip`，端口为 `null`），以及 `creator.name/version`（记在 `manifest.imported.creator`）。导入时固定补的：`actor: "human"`、`tab: "t1"`、`initiator: null`、`redirect: null`；`type` 由 §9.2 的表推（没有 `_resourceType` 时）。导入的总规则见 docs/04 §9.2。

### 2.3 Burp

【待验】没跑，只写路线：Burp 的 Logger++ 扩展可以导出 HAR（若其版本支持），Burp 自己的「Save items」是自家 XML，不是 HAR；若走 XML，要先转成 HAR 再 `bundle import har`。哪条路对，要拿到真实导出再看，不拿推测当结论。

## 3. decode 钩子与 mitmproxy addon 对应

tabcap 的 Python decode 插件（`templates/plugins/decode-python/`，docs/04 §26，0.6-B）有意保持 mitmproxy `flow` 的形状，所以把 addon 的 `response(flow)` 里解码 body 的部分搬过来通常只改签名和返回方式。靶场 s42（`x-enc: xor`，body 是 base64 的异或密文）：

mitmproxy addon（改写线上的响应）：

```python
import base64
from mitmproxy import http

KEY = b"..."  # your key

def xor(data):
    return bytes(b ^ KEY[i % len(KEY)] for i, b in enumerate(data))

def response(flow: http.HTTPFlow) -> None:
    if flow.response.headers.get("x-enc") != "xor":
        return
    flow.response.content = xor(base64.b64decode(flow.response.content.strip()))
```

tabcap decode 插件（`plugin.py`，只产生一个解码视图）：

```python
import base64

KEY = b"..."  # your key, read from config.json next to this file

def xor(data):
    return bytes(b ^ KEY[i % len(KEY)] for i, b in enumerate(data))

def decode(flow):
    msg = flow.response if flow.response is not None else flow.request
    if msg.headers.get("x-enc") != "xor":
        return None
    return xor(base64.b64decode(msg.content.strip()))
```

差别：

- **谁调、何时调**：addon 在代理里、请求经过时调，结果发给浏览器；`decode` 在 tabcap 要读一个已经录好的 body 时（`analyze find` / `deps` 等）由 `runner.py` 通过 stdin / stdout 逐行 JSON 调。
- **输入是冻结的一对**：`flow.request` / `flow.response` 的 `url`、`method`、`headers`（大小写不敏感，重复头用 `", "` 连起来，`get_all` 取全部）、`content`（bytes）、`status_code`；问请求 body 时 `flow.response` 是 `None`。没有 mitmproxy 的 `flow.id`、`metadata`、`client_conn`、`.set_content` 之类。
- **只读**：不能改线上，也不会改录下的原始 body。`decode` 返回 `bytes` / `str` 作为解码后的**视图**，另存为新 blob（标 `MIME`，没标就猜 JSON / 文本）；原 body 不动。
- **返回 `None`** 表示「我不管这个」。runner 也认 mitmproxy 的写法（给 `flow.response.content` / `.text` 赋值），但那只被当作返回值读走，不会回写任何东西。
- 不支持：`request` / `responseheaders` / `websocket_message` 这些钩子、addon 选项、`ctx`、异步。

## 复现

靶场用 `test/e2e/site.ts` 的 `startGuardSite()` 与 `startSearchSite()` 起，用 `curl --noproxy '' -x http://127.0.0.1:<port>` 发请求，退出 mitmdump 取 HAR。`uvx` 临时运行，没有全局安装。
