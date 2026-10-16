# 线路层指纹组件规范（wireprint）

2026-10-16。格 0.4-W1-spec，只写文档。作者 10-16 定：Zig 写的线路层指纹工具作为 tabcap 的组件放在 `native/wireprint/`（0.4-W1 已导入）。本文从该组件的源码与配套规范整理而来，描述**代码现状**；学习材料与代码不一致处以代码为准，逐条列在 §9。下文源码路径相对 `native/wireprint/`。

标注：【实测】本格在本机对 tabcap 的构建方式（`zig build -Dopenssl=false`，Zig 0.16.0）产出的二进制跑过（`wireprint --version` → `wireprint 0.1.0 (openssl=false)`；`serve` 与 OpenSSL 链接在 0.4-W2 删除前的过渡状态）；【推断】读代码推出；【待验】没确认；【待实现】0.4-W2 或之后。示例里不出现任何浏览器的具体指纹值。

0.4-W2 更新（2026-10-16）：`serve`、OpenSSL 与 `openssl` 构建选项已删除，构建命令是 `zig build`（发布二进制加 `-Doptimize=ReleaseSafe -Dstrip=true -Dtarget=<t>`），`version` 输出 `wireprint 0.1.0`；新增 `report` 子命令、新的退出码（§7）、画像的 `extension_order`（§4.2）、`diff` 的报告归一化（§5）。各节已按此改写，标「0.4-W2」【实测：`zig build test` 106 项全过，`src/cli.zig` 的测试覆盖每个退出码】。TLS 终结在 tabcap 的 Bun echo（docs/07 §6）。

## 1. 范围

| 层 | 计算什么 | 模块 | 现状 |
|---|---|---|---|
| TCP SYN | 客户端首个 SYN（无 ACK）的 window、IP TTL / hop limit、TCP 选项原始字节与 kind 序列、MSS、window scale | `net/eth_ip_tcp.zig`、`net/tcp_reassembly.zig` | 只来自 pcap 输入 |
| TLS ClientHello | record 头、ClientHello 全部字段、扩展原始顺序与长度、GREASE 位置、各扩展解码视图 | `tls/record.zig`、`tls/client_hello.zig`、`tls/grease.zig` | 已实现 |
| JA3 | 字符串 + MD5 | `fp/ja3.zig` | 已实现 |
| JA4 | JA4 / JA4_r / JA4_o / JA4_ro；CLI 固定传输层 `t` | `fp/ja4.zig` | 已实现 |
| HTTP/2 | 前言后到首个完整请求头块为止的帧序列、SETTINGS 有序对、连接级 WINDOW_UPDATE、PRIORITY 帧、伪头顺序、Akamai 串 `S\|WU\|P\|PS` | `h2/frame.zig`、`h2/hpack.zig`、`fp/akamai.zig`、`report.zig`（`collectH2`） | 已实现 |
| HTTP 头 | 头名原始顺序、白名单头的值、UA 与 Client Hints 自洽规则 H0–H5；HTTP/1.1 请求头（0.4-W2） | `report.zig`、`h1.zig`、`check/headers.zig` | 已实现 |
| 画像 / 检查 / diff | 由 N 份报告组画像；报告对画像逐层比对；任意两份 JSON 分层 diff | `profile.zig`、`check/claim.zig`、`diff.zig` | 已实现 |

不做：
- 不终止 TLS，没有 `serve` 子命令、不链接 OpenSSL（0.4-W2 已删除）；TLS 终结与连接管理由 tabcap 的 Bun echo 做（`src/wire/echo.ts`，docs/07 §6），组件只吃字节（`report`）。
- 不算 JA4H / JA4T（作者 10-16 定，代码已删）；TCP 层只输出 SYN 原始字段。
- 不生成、不改写任何 ClientHello 或 h2 帧；只读字节、算指纹、比对。
- 不打分。`check` 只给逐条规则的 finding（`info` / `warn` / `red`）和红黄计数，没有分数或概率。
- 不做 QUIC / DTLS 输入、JA4S / JA4L / JA4X、ECH 解密、IP / ASN 查询、实时抓 SYN（libpcap、`TCP_SAVED_SYN` 均未实现）。

## 2. 输入

| 子命令 | 吃什么字节 | 现状 |
|---|---|---|
| `parse` / `ja3` / `ja4 <file>` | 文件前 4 字节是 legacy pcap magic（`a1b2c3d4` / `d4c3b2a1` / `a1b23c4d` / `4d3cb2a1`）→ pcap 路径：linktype 0（DLT_NULL，两种字节序的 AF 头都试）或 1（Ethernet，含 `8100` / `88a8` VLAN）→ IPv4 / IPv6（走扩展头 0 / 43 / 60）→ TCP → 按四元组重组客户端方向 → 取首个 payload 以 `16 03` 开头的流。否则整份文件当作客户端→服务端的原始 TLS record 流（一条或多条 record，取第一条握手消息） | pcap 路径与原始 record 流都已实现【实测】 |
| `h2 <file>` | 客户端 h2 字节流：24 字节前言 + 帧，读到首个带 END_HEADERS 的头块（含 CONTINUATION）为止 | 已实现【实测】 |
| `report --client-hello <file> [--h2 <file> \| --h1 <file>] [--alpn P] [--sni N] [--peer H:P]`（0.4-W2） | 一条连接的原始字节：客户端→服务端的 TLS record 流（到 ClientHello 完整为止即可）+ 解密后的 h2 流（前言起）或 HTTP/1.1 请求头；`--alpn` / `--sni` / `--peer` 是 TLS 终结方才知道的事实 | 已实现【实测】；输出 §3.2 的每连接报告 |
| `profile ... <report.json>...` | N 份「每连接报告」JSON（§3.2 的完整形状） | 已实现；报告由 `report` 产出 |
| `check --claim <profile.json> <report.json>` | 一份画像 + 一份报告 | 同上 |
| `diff [--json] [--raw] <a.json> <b.json>` | 任意两份 JSON；两份都是报告时先归一化（§5） | 已实现 |

0.4-W2：tabcap 的 Bun echo（`src/wire/echo.ts`）记录每条连接到 ClientHello 完整为止的原始字节、在内部 `node:tls` 终结 TLS、读到首个请求为止的明文，把这些字节写成临时文件交给 `report`（docs/07 §6）。

pcap 路径的限制：pcapng（`0a0d0d0a`）→ `UnsupportedFormat`；IP 分片、非 IP / 非 TCP 帧 → 帧解析 `Unsupported`，被跳过；重组只支持按序、无重叠、无空洞，其它 → `Unsupported`；流没抓到 SYN 时从首个 payload 段开始，`tcp_syn` 缺省；没有符合条件的流 → `NoTlsPayload`。

大小上限：

| 项 | 上限 | 超出 |
|---|---|---|
| 输入文件 | 无（整份读入内存） | — |
| TLS record fragment | 2^14 字节（RFC 8446 §5.1） | `Malformed` |
| 跨 record 的 ClientHello | 拼进 64 KiB 栈上 scratch | `MessageTooLarge` |
| HPACK 动态表 | 4096 字节（SETTINGS_HEADER_TABLE_SIZE 初值） | `Malformed` |
| `sec-ch-ua` 品牌数 | 解析前 8 个 | 其余忽略 |
| h2 帧数 / 字节数 | `h2` 子命令无限制（读到首个完整头块或输入结束） | — |

畸形输入怎么报（不崩溃）：
- 解析器错误集：`error.Truncated` = 输入在已声明的长度之前结束，多给字节可能修好（record 头、record fragment、握手消息、pcap 记录、h2 帧头与前言、HPACK）；`error.Malformed` = 完整容器内部自相矛盾，多给字节也修不好（内层长度越出外层、长度不在 `<floor..ceiling>`、u16 列表奇数字节、扩展块没被 type/length/data 精确铺满、重复扩展类型、结构后有多余字节、record 长度 > 2^14、需要握手 record 处出现别的 ContentType、h2 帧 payload 长度与类型 / flags 矛盾）；另有 `NotClientHello`、`MessageTooLarge`、`UnsupportedFormat`、`Unsupported`、`NoTlsPayload`。
- 解析路径不用 `unreachable` / `@panic` / `catch unreachable`（`root.zig` 自述的纪律）；是否所有路径都守住【待验】。
- CLI 层（0.4-W2）：加载或解析失败在 **stderr** 打一行 `error: <文件>: <阶段>: <错误名>`，stdout 什么也不写，退出码 1（§7）【实测：`src/cli.zig` 测试——读不到的文件、h2 字节当 ClientHello、ClientHello 当 h2、h2 前言当 h1、缺参数、未知子命令】。JA3 / JA4 计算失败写成该字段的字符串值 `"error: <错误名>"`，报告照常输出；h2 帧 / HPACK 错误写进 `http2.frame_error` / `http2.hpack_error`，报告照常输出。
- 原「扩展体畸形在半份 JSON 之后退出」的缺口已补：输出先写进内存缓冲，出错时整份丢弃；`report` 在写 JSON 之前先把扩展块走一遍，畸形直接按输入错误退出【推断：读代码；CLI 测试只覆盖到非 ClientHello 的输入】。

## 3. 字段定义

### 3.1 规范化

- 十六进制一律小写、无 `0x`：u16 定宽 4 位（`0x001d` → `001d`），u8 2 位，字节串整串 hex。哈希小写：MD5 32 位，JA4 段为 SHA-256 前 12 位。
- 十进制例外：JA3 串、Akamai 串、`http2.settings` 的 id 与值、`tcp_syn` 的数值、各类长度 / 计数。
- 列表一律保持线上顺序且**含 GREASE**；GREASE 另记位置。头名按 HPACK 解码结果原样（HTTP/2 为小写）。

### 3.2 每连接报告的形状

完整报告（`profile` / `check` / `diff` 按这个形状读；0.4-W2 起由 `report` 产出）：

```
{ "wireprint": "0.1.0",
  "connection": { "peer", "record_bytes" },                            // --peer; first record's 5 + length
  "tls": { "handshake": { "version", "cipher", "alpn", "sni", "session_reused", "hello_retry" },
           "client_hello": {§3.3}, "ja3": {§3.5}, "ja4": {§3.5} },
  "http2": {§3.6} | null,                                              // null for --h1 or no request bytes
  "http": {§3.7} | null }
```

`report` 写 `handshake.alpn` / `sni`（来自参数），`version` / `cipher` / `session_reused` / `hello_retry` 写 `null`。tabcap 的 echo 拿到报告后补上它在 TLS 侧看到的 `version` / `cipher` / `session_reused`，并在顶层加 `role`（由请求路径定：`/` navigation、`/fetch` fetch、`/client` client，其余 other）和 `echo{conn, path, role, alpn, sni, psk, sessionReused, protocol, receivedAt}`；`profile` 读 `role` 分角色记头顺序（§4.1），`diff` 归一化时忽略 `echo` / `role` / `connection`。

其它子命令只产出一部分：`parse` 在**顶层**给 `input`、`input_kind`（`pcap` | `raw-tls-stream`）、`record{content_type, legacy_version, length, stream_bytes}`、`client_hello`、`tcp_syn`（仅 pcap 且抓到 SYN）、`ja3`、`ja4`；`ja3` / `ja4` 只给对应对象；`h2` 给 `input`、`http2`、`http`。把 `parse` 输出直接喂给 `check` 时 T1–T7 被静默跳过，T8 / N3 / H0 误报【实测，0.4-W1-spec】，所以喂 `check` 的一律是 `report` 的输出。

### 3.3 `client_hello`

| 字段 | 类型 | 来源字节 | 说明 |
|---|---|---|---|
| `legacy_version` | hex4 | ClientHello.legacy_version | |
| `random` | hex（64 字符） | random[32] | 每连接随机 |
| `session_id` / `session_id_length` | hex / int | legacy_session_id<0..32> | |
| `cipher_suites` | [hex4] | cipher_suites | 线上顺序，含 GREASE |
| `cipher_grease_positions` | [int] | 同上 | 0 起下标 |
| `compression_methods` | [hex2] | legacy_compression_methods | |
| `extension_count` | int | extensions | 含 GREASE |
| `extensions` | [{`type` hex4, `length` int}] | 每个 Extension | 线上顺序 |
| `extensions_order` | [hex4] | 同上 | |
| `extension_grease_positions` | [int] | 同上 | |
| `server_name` | string\|null | `0000` 的 host_name | 非 host_name 类型或多个名 → `Malformed` |
| `alpn` | [string]\|null | `0010` | |
| `supported_versions` / `supported_groups` / `signature_algorithms` | [hex4]\|null | `002b` / `000a` / `000d` | 含 GREASE |
| `key_share_groups` | [hex4]\|null | `0033` 各项 group | |
| `key_shares` | [{`group` hex4, `key_exchange_length` int}]\|null | `0033` | 公钥本身不输出 |
| `ec_point_formats` | [hex2]\|null | `000b` | |
| `has_pre_shared_key` / `has_encrypted_client_hello` / `has_trust_anchors` | bool | `0029` / `fe0d` / `ca34` 是否存在 | |
| `has_application_settings` | bool | `4469` 或 `44cd` 是否存在 | |
| `message_length` | int | 握手消息 | 含 4 字节握手头【推断】 |

### 3.4 `tcp_syn`（仅 pcap）

`window` int、`ttl` int（IPv4 TTL / IPv6 hop limit）、`options_hex` hex（原始选项字节，含 EOL 后的补零）、`options` [int]（选项 kind 序列，含 NOP=1，遇 EOL=0 记下后停止）、`mss` int|null（kind 2 且 2 字节）、`window_scale` int|null（kind 3 且 1 字节）。

### 3.5 `ja3` / `ja4`

- `ja3`：`{string, hash}`。串 = `legacy_version,ciphers,extensions,supported_groups,ec_point_formats`，全十进制，字段内 `-`、字段间 `,`，线上顺序，各 u16 列表去 GREASE，缺字段留空保留逗号；`extensions` 含 `0000` / `0010`。`hash` = MD5。
- `ja4`：`{ja4, ja4_r, ja4_o, ja4_ro}`。规则按 FoxIO JA4.md：去 GREASE；版本取 supported_versions 最高非 GREASE 值，否则 legacy_version；`d` / `i` 看 `0000` 是否存在；两位计数（>99 记 99，扩展计数含 `0000` / `0010`，SCSV 与 `fe00`–`feff` 计入）；ALPN 取首个名的首末字节，非字母数字走 hex 规则；JA4_c 去 `0000` / `0010` 后排序，有非 GREASE 签名算法时接 `_` + 签名算法线上顺序；空列表 `000000000000`。`_o` 线上顺序且保留 `0000` / `0010`；`_r` / `_ro` 不哈希。

### 3.6 `http2`

| 字段 | 类型 | 说明 |
|---|---|---|
| `frames` | [{`type` int, `type_name`, `length`, `flags` hex2, `stream_id`}] | 前言后到首个完整头块为止的每一帧 |
| `frame_error` / `hpack_error` | string | 只在出错时出现 |
| `settings` | [[id, value]] | 首个 HEADERS 之前所有非 ACK SETTINGS 帧的对，按出现顺序拼接 |
| `window_update` | int\|null | 首个 stream 0 WINDOW_UPDATE 的增量 |
| `priority_frames` | [[stream, exclusive 0/1, dependency, weight]] | PRIORITY 帧；weight 为线上字节值；HEADERS 内的 PRIORITY flag 不算 |
| `pseudo_header_order` | [string] | 伪头**全名**（`:method` …）按解码顺序 |
| `headers_stream_id` | int\|null | |
| `akamai` | string | `S\|WU\|P\|PS`：S = `id:value` 以 `;` 连；WU 无则 `00`；P = `stream:excl:dep:weight+1` 以 `,` 连，无则 `0`；PS = `m`/`a`/`s`/`p` 以 `,` 连，其它伪头跳过；全十进制 |

### 3.7 `http`

`version` `"2"` | `"1.1"`（0.4-W2）；`header_count` int；`headers_order` [string]（含伪头；HTTP/1.1 头名保留线上大小写）；`headers` [{`name`, `value`?}]——`value` 只对伪头和白名单输出：`user-agent`、`accept`、`accept-language`、`accept-encoding`、`sec-ch-ua*`（8 个）、`sec-fetch-site/mode/user/dest`、`upgrade-insecure-requests`、`priority`、`te`、`dnt`、`sec-gpc`、`cache-control`、`pragma`、`connection`、`host`；`cookie`、`authorization` 等的值从不输出。另有 `user_agent`、`sec_ch_ua`、`sec_ch_ua_platform`、`accept_language`（string|null）与 `checks`（H0–H5 的 finding，§5）。

### 3.8 GREASE 与「同集合不同顺序」

- GREASE = RFC 8701 §2 的 16 个 u16 值（两字节相同、低半字节 `a`）。原始字段保留，JA3 / JA4 计算前从每个列表剔除。
- 归一化各处不同：画像的 `extensions_sorted` 去 GREASE 和 `0029`；`check` 比较前去 GREASE，扩展相关比较再去 `0029`；`diff` 对两份报告去 GREASE、去 `0029` 并把 PSK 记为标签（0.4-W2，§5），`--raw` 时不归一化（GREASE 值变化显示为 `+`/`-`）。
- 「同集合不同顺序」：`check` 把两边数组判为 `equal` / `reordered`（等长且每个元素都在对方里）/ `different` / `missing`（任一边缺字段，不出 finding）；`reordered` 报 `same set, different order`。扩展另算：集合排序后比（T3），顺序只在画像 `extension_order` 为 `fixed` 时比（T4；`unknown` 不比）。`diff` 对标量数组与「标量元组数组」（`settings` 的二元组、PRIORITY 记录）整体判 `equal` / `reordered` / `changed`（0.4-W2），对象数组按下标逐项比。

### 3.9 哪些字段在同一浏览器的两次连接间变化

| 字段 | 变化 | 依据 |
|---|---|---|
| `random`、`session_id` | 每次不同 | 【实测：同一浏览器两份本地报告 diff】 |
| GREASE 值（cipher / 扩展 / groups / key_share / versions / sigalgs） | 每次重抽；位置是否固定因客户端而异 | 【推断：RFC 8701；画像按位置记录】 |
| 扩展顺序 | 部分客户端每连接重排，部分固定 | 【实测：上同 diff 逐下标变化】；画像用 `extension_order`（randomized / fixed / unknown）记 |
| `key_shares` | 组固定，公钥每次随机（只输出长度） | 【推断】 |
| PSK（`0029`） | 只在会话恢复时出现：`extension_count` +1、JA4_a 扩展计数 +1、JA4_c 变、JA3 变、`message_length` 变 | 【实测：上同 diff】 |
| `fe0d`（GREASE ECH）长度 | 两份样本不同，是否与 PSK 无关 | 【待验】 |
| 去 GREASE 后的 cipher、groups、sigalgs、ALPN、versions、点格式；h2 SETTINGS / WINDOW_UPDATE / PRIORITY / 伪头顺序 | 稳定 | 【推断】；画像用 `*.stable_across_samples` 记 |
| 头名顺序 | 随请求类型变（导航与子资源不同） | 【实测：子资源报告对导航画像 N1 报 warn】 |

JA3 与 JA4：JA3 用线上顺序，扩展重排或出现 PSK 就变；JA4 排序后哈希，重排不变、PSK 会变（画像单独存 `session.resumed_ja4`）；JA4_o / JA4_ro 用线上顺序，随重排变。画像的 `ja3` / `ja4.stable_across_samples` 只看非 PSK 样本。

## 4. 画像（profile）与语料

### 4.1 记录格式

`spec/profile-schema.md` 原文原则：

> 字段名用 snake_case。所有十六进制值小写、无 `0x` 前缀、定宽（u16 为 4 位）。原则：**哈希与原始列表同时存**——哈希用于匹配，原始列表用于 diff 与解释。

`profile.zig` 实际写出的结构（以代码为准，值为类型）：

```jsonc
{
  "schema_version": 1,
  "id": "<name>/<major>/<os>-<arch>/<version>",       // major = version 第一个 '.' 之前
  "subject":  { "kind": "browser|library|tool", "name": str, "version": str, "channel": str|null, "claims": str|null },
  "platform": { "os": str, "os_version": str|null, "arch": str, "headless": bool },
  "capture":  { "captured_at": str|null, "method": str, "server": str, "server_host_os": str,
                "connection": "first|resumed", "samples": int, "raw_dir": str|null },
  "tls": {
    "ja3": { "string", "hash", "stable_across_samples": bool },
    "ja4": { "ja4", "ja4_r", "ja4_o", "ja4_ro", "stable_across_samples": bool },
    "handshake": { "version", "cipher_negotiated", "alpn_negotiated" },   // 报告有 tls.handshake 才有，否则 null
    "client_hello": {
      "legacy_version", "session_id_length", "cipher_suites", "cipher_grease_positions", "compression_methods",
      "extensions_order_samples": [[hex4]],      // 每个非 PSK 样本的原始顺序（含 GREASE）
      "extensions_sorted": [hex4],               // 参考样本，去 GREASE 与 0029，升序
      "extension_count",
      "extension_order": "randomized"|"fixed"|"unknown",   // 0.4-W2; unknown: fewer than 2 samples judged
      "extension_order_samples_judged": int,
      "extension_order_randomized": bool|null,              // null when unknown
      "extension_grease_positions",
      "supported_versions", "supported_groups", "key_share_groups", "key_shares", "signature_algorithms",
      "ec_point_formats", "alpn",
      "sni_present": bool, "psk_present": bool, "ech_present": bool, "ech_kind": "grease-or-real"|null,
      "trust_anchors_present": bool, "alps_codepoint": "4469"|"44cd"|null,
      "total_length": int,                       // = message_length
      "tcp_segments": null                       // 总是 null
    }
  },
  "http2": { "akamai", "settings", "window_update", "priority_frames", "pseudo_header_order",
             "sends_priority_header": bool, "no_rfc7540_priorities": int|null, "stable_across_samples": bool },
  "http": { "method", "version": "2", "headers_order": [str],   // 去伪头
            "user_agent", "client_hints": { "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-ch-ua-full-version-list" },
            "accept", "accept_encoding", "accept_language", "sec_fetch_mode", "sec_fetch_dest", "checks",
            "roles": { "<role>": { "samples", "method", "headers_order", "headers_order_stable_across_samples",
                                   "accept", "sec_fetch_site", "sec_fetch_mode", "sec_fetch_dest" } } },   // 0.4-W2
  "tcp": { "window_size", "options", "mss", "window_scale", "ttl_observed", "source": "pcap"|null },
  "session": { "resumption_observed": bool, "resumed_ja4": str|null, "resumed_session_reused": bool|null,
               "connections_per_page_load": null },
  "notes": str
}
```

未注明的字段：从参考样本原样复制，缺则 `null`。

### 4.2 从 N 份报告组画像

1. 输入 0 份 → `EmptyInput`；第一份没有 `tls.client_hello` → `NotAReport`。
2. 分类：`has_pre_shared_key=true` 的是恢复样本，其余是首连样本。
3. 参考样本 = 第一个 `sec-fetch-mode: navigate` 的首连样本；没有则第一个首连样本；再没有则第一份。几乎所有单值字段取自参考样本。
4. `capture.connection` = 有首连样本则 `first`，否则 `resumed`；`capture.samples` = N。
5. `extensions_order_samples` = 所有首连样本的原始顺序（全是恢复样本时用全部）。参与判断的样本少于 2 个 → `extension_order: "unknown"`、`extension_order_randomized: null`（一个样本分不出固定与随机，0.4-W2）；否则任一样本去 GREASE / `0029` 后与参考样本顺序不同 → `randomized` / `true`，全同 → `fixed` / `false`。`extension_order_samples_judged` 记参与判断的样本数。
6. `ja3` / `ja4.stable_across_samples`：首连样本（无首连则全部）的哈希全相同；`http2.stable_across_samples`：全部样本的 Akamai 串全相同。
7. `session`：第一个恢复样本的 `tls.ja4.ja4` 与 `tls.handshake.session_reused`。
8. `tcp.*` 取参考样本的 `tcp_syn`；连接层报告没有 `tcp_syn`，所以这种报告组出的画像 `tcp` 全为 `null`【实测：两份本地连接层报告组成的画像】。
9. `http.roles`（0.4-W2）：报告顶层的 `role`（tabcap 的 echo 写），没有时 `sec-fetch-mode: navigate` 记 `navigation`、其余 `other`；每个角色按首次出现的顺序一条，参考是该角色的第一份样本，`headers_order_stable_across_samples` 比较该角色全部样本的非伪头顺序。顶层 `http.*` 仍取参考样本（导航），`check` 的 N1 读它。
10. 选项（0.4-W2）：`--server <s>`、`--server-host-os <os>` 写进 `capture.server` / `capture.server_host_os`（默认 `wireprint-report 0.1.0` / `unknown`）。tabcap 在组件输出之外加顶层 `tabcap` 段：`cftVersion`、`flags`（启动参数，本机路径换成 `<profile>` / `<extension>`）、`flagsSha256`、`tabcapVersion`、`capturedAt`、`samples{navigation, fetch}`、`psk{navigation, fetch}`、`sessionTickets: "disabled"`。

### 4.3 语料布局与约束

- 路径：`native/wireprint/corpus/<browser>/<major>/<os>-<arch>/<version>.json`。`profile` 只往 stdout 写，不落盘、不校验路径；`tabcap wire profile` 写进 tabcap 缓存（`<cache>/wire/profiles/cft-<version>-<os>-<arch>.json`，样本报告在同名 `.samples/`），入库的是它的拷贝。0.4-W2 起有 `corpus/chrome/155/macos-arm64/155.0.8059.79.json`（`--name chrome --channel for-testing`）；Linux / Windows 的从 CI e2e 上传的 `wire-profile-<os>` 产物补。
- **本仓库只收 tabcap 集成发布的 Chrome for Testing 版本、由 tabcap 自己采得的画像**，每个 os-arch 一份（作者 10-16 定，0.4-W2 起采）；个人浏览器、手工抓包、第三方流量、文章或其它项目里的数值一律不收。CfT 用 `chrome` 目录（0.4-W2 任务书给定的路径），`subject.channel` 为 `for-testing`。采集必须用 tabcap 启动 CfT 的生产参数（`launcher.ts` 的 `buildArgs`）：只加 `--disable-field-trial-config` 一项就会让 ClientHello 少扩展 `12e0`、`accept-language` 换位置（0.4-W2 spike【实测】）。
- `spec/profile-schema.md` 的约束（原文）：
  - `id` 与文件路径一致：`corpus/<name>/<major>/<os>-<arch>/<version>.json`。
  - 所有 `*_order` / `*_samples` 字段保持原始顺序；所有 `*_sorted` 字段升序。
  - 采集不到的字段填 `null`，不要省略键，让 diff 能区分"没采"和"没有"。
  - 不存 Cookie 值、不存 Authorization 等敏感头的值；`headers_order` 只有名字。

## 5. 一致性检查与 diff

`check --claim <profile.json> <report.json>` 输出 JSON（0.4-W2；原来是文本行）：`{"claim": <画像 id>|null, "verdict": "CONSISTENT"|"INCONSISTENT", "red": n, "warn": n, "findings": [{"rule", "severity", "message"}]}`，有任一 `red` 即 INCONSISTENT，退出码 3（JSON 照常在 stdout），否则 0。规则写死在 `check/claim.zig` / `check/headers.zig`，不是数据文件。

| 规则 | 比什么 | severity |
|---|---|---|
| I0 | 打印画像 `id` | info |
| T1 | `tls.ja4.ja4`；报告带 PSK 且画像有 `session.resumed_ja4` 时与后者比 | 不同 red；PSK 但画像无恢复样本 warn；相同 info |
| T2 | `cipher_suites`（去 GREASE） | red（同集合异序或不同） |
| T3 | 扩展集合（去 GREASE、`0029`，排序）对 `extensions_sorted` | red |
| T4 | 画像 `extension_order` 为 `fixed`（旧画像：`extension_order_randomized=false`）时，扩展顺序对 `extensions_order_samples[0]`；为 `unknown` 时不比，只给一条 info（0.4-W2） | 样本 ≥ 2 red，否则 warn；unknown 为 info |
| T5 | `supported_groups`、`key_share_groups` | red |
| T6 | `signature_algorithms` | red |
| T7 | `alpn`、`supported_versions` | red |
| T8 | ECH 是否存在、trust_anchors 是否存在、ALPS 码点 | red |
| A1 | Akamai 串 | 不同 red，相同 info |
| A2 | SETTINGS 对（仅 A1 不同时） | red |
| A3 | WINDOW_UPDATE（仅 A1 不同时） | red |
| A4 | 伪头同集合异序（仅 A1 不同时） | red |
| N1 | 非伪头头名顺序 / 集合 | 报告是导航请求 red，否则 warn |
| N2 | UA 主版本、UA 家族 | red |
| N3 | `sec-ch-ua` 是否存在 | red |
| H0 | 无 `user-agent` | warn |
| H1 | Chromium 系 UA 但无 `sec-ch-ua` | warn |
| H2 | UA 主版本不在 `sec-ch-ua` 的非 GREASE 品牌版本里 | red |
| H3 | UA 平台与 `sec-ch-ua-platform` 不符 | red |
| H4 | UA 含 `HeadlessChrome` | red |
| H5 | 非 Chromium UA 却带 `sec-ch-ua` | red |

TCP 层没有规则（源码原有的 C1 随 JA4T 一并删除）。

`diff [--json] [--raw] <a> <b>`：按顶层键分组，每组先打组名，组内每个不同的叶子一行：`<路径> <a> -> <b>`、`+<b>`（只在 b）、`-<a>`（只在 a）；标量数组（以及标量元组数组）同集合异序打 `reordered (same N values, different order)`，否则打集合差 `+x -y`；对象数组按下标比。末行 `summary: <n> changed, <n> reordered, <n> added, <n> removed, <n> unchanged`。`unchanged` 行只在库函数的 `verbose` 选项下打印，CLI 没有开关。

报告归一化（0.4-W2，两边都有 `tls.client_hello` 时默认做，`--raw` 关掉）：同一个 Chrome 的两条连接不应有差异——
- 每个列表（cipher、supported_versions、groups、key_share_groups、sigalgs、key_shares）去 GREASE；`extensions` 换成去 GREASE、去 `0029` 后排序的类型集合，另记 `extension_grease_count`，`extension_count` 按集合重算；
- 带顺序的值不比：`extensions_order`、`extension_grease_positions`、`ja3`、`ja4_o`、`ja4_ro`（扩展顺序由 `check` 的 T4 对画像判断）；
- 每连接的值不比：`random`、`session_id`、`message_length` 与扩展长度（ECH GREASE 填充随机）、`connection`、`wireprint`、`echo`、`role`、`http2.frames[].length`、`:path` / `:authority` / `host` 的值（指向 echo 本身）；`http.headers` 变成按线上顺序的 `{名: 值}` 对象，重名加 `#2`；
- PSK：两边 `has_pre_shared_key` 不同时只出一个标签 `psk`，不算字段差异；此时 `ja4.ja4` / `ja4_r` / `handshake.session_reused` 也不比。
`--json` 输出 `{"normalized": bool, "labels": [{label, a, b}], "ignored": [{path, reason}], "differences": [{path, kind: changed|reordered|added|removed, a, b}], "summary": {...}}`；被忽略的路径全部列在 `ignored`，文本输出另有一行 `normalized: …`。【实测：CfT 155 两次首连 → 0 差异；首连对恢复 → 只有 `psk` 标签，`tls` 段无差异（`src/cli.zig` 测试，输入是 0.4-W2 spike 的 CfT 字节）】

## 6. 算法参考与 oracle

| 算法 | 规范 | 许可 | oracle |
|---|---|---|---|
| JA3 | https://github.com/salesforce/ja3 README（commit `502cc6395811c54743b0561419d61900a6df3ff7`） | BSD-3-Clause | README 的两组「串 → MD5」 |
| JA4 | https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/JA4.md（commit `16b96d95c220762cf658f67d678cda2aac95c81e`） | BSD-3-Clause（FoxIO `LICENSE-JA4`） | `spec/test-vectors.json` 的 `ja4` 块（官方例子、ALPN 规则、版本映射）；冲突时规范原文 > Wireshark 核心 > FoxIO Python / Rust |
| Akamai HTTP/2 | Black Hat EU 2017 白皮书 *Passive Fingerprinting of HTTP/2 Clients*（https://blackhat.com/docs/eu-17/materials/eu-17-Shuster-Passive-Fingerprinting-Of-HTTP2-Clients-wp.pdf） | — | 白皮书示例串（只核格式）；`fixtures/h2/*.bin` |

用到的规范章节：RFC 8446 §4.1.2（ClientHello）、§4.2（扩展、重复类型）、§5.1（record）；RFC 9846（取代 8446，线格式不变，代码同时引用）；RFC 5246 §7.4.1.2（TLS 1.2 ClientHello 同布局）；RFC 8701 §2（GREASE）；RFC 7301（ALPN）；RFC 9113 §3.4 前言、§4.1 帧头、§4.3 HPACK 错误、§6.1–6.10 各帧（取代 RFC 7540，帧格式不变；PRIORITY 的 weight+1 语义见 RFC 7540 §6.3）；RFC 9218（`SETTINGS_NO_RFC7540_PRIORITIES` = `0x9`）；RFC 7541 §4.1 / §5.1 / §5.2 / §6、附录 A（静态表）/ B（Huffman）/ C（例子）；RFC 9293 §3.1、RFC 2018、RFC 7323（TCP 选项）；RFC 791、RFC 8200 §4；pcap-savefile(5)；WICG UA Client Hints 与 RFC 8941（`sec-ch-ua`）。

oracle 规则：expected 只来自 Wireshark / tshark、FoxIO 参考向量、RFC 附录、OpenSSL oracle 程序（`tools/openssl_oracle.c`：把 `.bin` 喂给 OpenSSL 服务端状态机，原样输出它自己解析的字段），以及生成脚本写进线上的常量；不来自推理，不来自被测代码。改 expected 先写理由、作者确认。

| fixture | 真实 / 合成 | 内容 | expected 来源 |
|---|---|---|---|
| `fixtures/clienthello/*.bin`（6 份 + 0.4-W2 的 3 份 `cft-155-macos-*`） | 真实采集 | 三种桌面浏览器对本机自签服务器发出的首个 TLS record（5 字节头 + ClientHello），单 record 单 segment；首连与会话恢复（`-psk`）各有；SNI 为 `localhost`。`cft-155-*` 是 CfT 155 经 0.4-W2 spike 的 Bun relay 的首个 record（两次首连、一次恢复） | `*.expected.json` = OpenSSL oracle 原样 stdout（只含 OpenSSL 认识的扩展；未识别扩展的位置没有 oracle） |
| `fixtures/pcap/*.pcap`（6 份） | 合成 | `tools/mkpcap.py` 用固定常量造链路 / IP / TCP 头，TLS payload 原样搬自上一行的 `.bin`；覆盖 DLT_NULL 两种字节序、Ethernet + VLAN 噪声帧、IPv6 扩展头链、两段拆分且 seq 绕过 2^32、纳秒 magic、只有 SYN、截断；SYN 选项值只是形状示意，不是任何真实 TCP 指纹 | 生成脚本写进去的值 + 脚本内独立读取器自检；`tcpdump -r -nn -vv` 作第三方对照 |
| `fixtures/h2/*.bin`（3 份） | 真实采集 | 三种浏览器的客户端 h2 字节流（前言 + 帧到首个请求）；其中一份在 HEADERS 之前结束（只有 SETTINGS / WINDOW_UPDATE / SETTINGS）【实测】；头名里没有 `cookie`【实测】 | 帧头字段人工逐字节核对；Chromium 默认 SETTINGS 源码对照 |
| `fixtures/hpack/c*.hex` + `.json`（16 对） | 规范摘录 | RFC 7541 附录 C.2–C.6，含每块之后的动态表 | 脚本从 RFC 原文抽取，不含解码逻辑 |
| `spec/test-vectors.json` | 规范摘录 | JA4 官方例子 / ALPN / 版本映射 / 计数规则、GREASE 16 值、HPACK 整数 C.1、静态表抽查、h2 前言 / 帧类型 / SETTINGS id、Akamai 形状例子、pcap magic、TLS 扩展类型与命名组 | 各自规范原文 |
| `spec/hpack-huffman.json` | 规范摘录 | RFC 7541 附录 B 的 257 项码表 | 脚本抽取并做前缀 / Kraft 校验 |

复现：仓库根目录 `bun run test:native`（即组件内 `zig build test`，离线、`@embedFile`）。0.4-W2 另有 `fixtures/h2/cft-155-macos-{nav,favicon}.bin`（同一 spike 的解密 h2 流）与手写的 `fixtures/h1/get-basic.bin`（RFC 9112 语法，oracle 是文件本身）。

## 7. CLI 契约（源码现状）

| 子命令 | 参数 | stdout |
|---|---|---|
| `parse` | `<pcap\|bin>` | JSON（缩进 2）：§3.2 的 `parse` 顶层形状 |
| `ja3` | `<pcap\|bin>` | JSON：`input`、`input_kind`、`ja3` |
| `ja4` | `<pcap\|bin>` | JSON：`input`、`input_kind`、`ja4` |
| `h2` | `<bin>` | JSON：`input`、`http2`、`http` |
| `report`（0.4-W2） | `--client-hello <file>` 必填；`--h2 <file>` 或 `--h1 <file>`（二选一，可都不给）；`--alpn <proto>`、`--sni <name>`、`--peer <host:port>` | 每连接报告 JSON（§3.2） |
| `profile` | 必填 `--name --version --os --arch`；可选 `--channel --os-version --headless --method --claims --captured-at --raw-dir --kind --notes --server --server-host-os`；位置参数为 1..N 份报告 | 画像 JSON（§4.1） |
| `check` | `--claim <profile.json> <report.json>` | JSON：claim、verdict、red、warn、findings（§5） |
| `diff` | `[--json] [--raw] <a.json> <b.json>` | 分组 diff + summary 行，或 `--json` 的 JSON（§5） |
| `version` / `--version` | — | `wireprint 0.1.0` |
| `help` / `--help` / `-h` | — | usage（stdout，退出码 0） |

退出码（0.4-W2，`src/cli.zig`；每条路径都有测试【实测】）：

| 码 | 何时 |
|---|---|
| 0 | 成功；`help` |
| 1 | 用法或输入错误：无参数（usage 打在 stderr）、未知子命令、缺参数 / 多余参数 / 未知选项、文件读不到、字节解析不了（非 ClientHello、无 h2 前言、非 HTTP/1.1 请求头）、非 JSON、`profile` 的 `NotAReport`。stderr 一行 `error: …`，**stdout 为空** |
| 3 | `check` 的 verdict 为 INCONSISTENT；JSON 照常在 stdout |

崩溃（信号、退出码不是 0 / 1 / 3）由调用方当作内部错误；tabcap 把 1 映射为 `bad-input`，其它非零为 `internal`（`src/wire/native.ts`）。`check --claim` 收画像文件路径。

## 8. 许可证

- 组件与仓库其余部分一样是 Apache-2.0（作者 10-16 定）。第三方声明（JA3 的 salesforce BSD-3、JA4 的 FoxIO BSD-3、RFC 摘录的 IETF Trust 条款）放根目录 `NOTICE`。
- JA4H / JA4T（FoxIO License 1.1、FoxIO 称其方法专利申请中）的实现与 `-Dja4plus` 构建开关在导入时已删除（作者 10-16 定），组件里没有 FoxIO License 1.1 范围的代码。

## 9. 代码与学习材料 / 配套规范不一致处（以代码为准）

1. 输入：原始 TLS record 流与原始 h2 流在代码里已能吃（`parse` / `ja3` / `ja4` / `h2`）；本格任务书把它们列为 0.4-W2 计划。0.4-W2：tabcap 的 echo 经 `report` 接入。
2. 子命令：任务书列 `parse / ja3 / ja4 / profile / check / diff`；代码另有 `h2`、`version`。
3. `check --claim` 收画像文件路径，不是学习材料与 usage 文本里的画像 id。
4. 一致性规则写死在代码里；学习材料计划的 `rules/*.json` 数据化规则不存在（目录为空）。
5. JA4H / JA4T：学习材料说本项目实现并输出两者；组件里已删除（连同 TCP 规则 C1 与画像的 `http.ja4h` / `tcp.ja4t`）；SYN 只来自 pcap，libpcap / `TCP_SAVED_SYN` 实时抓取未实现。
6. JA3：学习材料说 JA3 不含 SNI / ALPN 信息；代码按 README 把扩展类型全列进去，`0000` / `0010` 在内，所以 JA3 编码了二者是否存在。
7. 错误语义：学习材料写「任何长度越界返回 `Truncated`」；代码只在输入在已声明长度之前结束时报 `Truncated`，容器内部的越界报 `Malformed`。
8. `pre_shared_key` 必须是最后一个扩展：解析器不强制，检查层也没有对应规则。
9. 画像结构与 `spec/profile-schema.md`：`tls.ja4` 键是 `ja4/ja4_r/ja4_o/ja4_ro`（规范写 `fingerprint/raw/original/raw_original`）；`settings` 的 id 是整数（规范写字符串）；`pseudo_header_order` 存伪头全名（规范写 `m/a/s/p`）；`ech_kind` 只有 `grease-or-real`（规范写 `grease|real`）；`tcp.source` 是 `pcap`（规范写 `libpcap|tcp_saved_syn`）；没有 `record_legacy_version`、`padding_length`；`tcp_segments`、`connections_per_page_load` 恒为 `null`，没有 `ja4h` / `ja4t`；代码多出 `tls.handshake`、`compression_methods`、`extension_count`、`key_shares`、`trust_anchors_present`、`http2.stable_across_samples`、`http.sec_fetch_mode/sec_fetch_dest/checks`、`session.resumed_session_reused`。
10. 语料：学习材料的原始字节放 `<version>.samples/`、画像路径曾写作 `corpus/<browser>/<version>/<os>.json`；代码只写 stdout，`raw_dir` 由 `--raw-dir` 透传。采集脚本学习材料写 Playwright 的 `capture.py`，组件里原有 `capture.sh`（驱动本机日常浏览器，0.4-W2 已删）；tabcap 只收 CfT 画像，由 `tabcap wire profile` 采（§4.3）。
11. `diff` 输出：学习材料的样例按 `TLS` / `HTTP/2` 大写分组、hex 带 `0x`、打印 `unchanged`；代码按顶层 JSON 键分组、hex 无前缀、CLI 不打印 `unchanged`。
12. 规范引用：任务书写 RFC 7540；代码引用取代它的 RFC 9113（7540 只用于 PRIORITY weight 语义）。
