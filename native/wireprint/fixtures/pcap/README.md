# fixtures/pcap — 合成的 legacy pcap

pcap reader（`src/pcap.zig`）、帧解析（`src/net/eth_ip_tcp.zig`）与 TCP 重组（`src/net/tcp_reassembly.zig`）的测试输入。

**这些文件是合成的**：TLS payload 是 `../clienthello/*.bin` 里真实浏览器的首个 TLS record（原样搬入），但链路层 / IP / TCP 头全部由 `tools/mkpcap.py` 按固定常量构造。因此：

- 这里的 SYN 选项、window、TTL、MSS **不是**任何浏览器或 macOS 的真实 TCP 指纹，只是"形状像 macOS"的示意值（以采集为准）。TCP 层的真实数值只能来自 `corpus/` 里的实抓样本，不要从这里抄。
- 期望值（`<name>.expected.json`）是生成脚本**写进线上的值**，不是 Zig 解析器的输出；测试从 JSON 读期望，解析器与期望互相独立。

## 生成方式

```sh
python3 tools/mkpcap.py        # 从仓库根运行；纯 Python 标准库
```

- **幂等**：时间戳（`ts_sec` 基准 1790164800 = 2026-09-23T12:00:00Z）、MAC/IP/端口、ISN、IP ID、TCP timestamp 全是常量；重跑后每个文件字节相同（脚本打印每个 pcap 的 sha256，JSON 里也有 `file_sha256`）。
- **自检**：脚本写完后用一个独立的 `struct` 小读取器（`_self_check`）重读每个 pcap，核对记录数、每条记录 offset / incl_len / orig_len 与 JSON 一致；并断言重组后的 payload 长度 == 原 `.bin` 长度、sha256 相同。
- **第三方 oracle**：`tcpdump -r fixtures/pcap/<name>.pcap -nn -vv`（macOS 自带）。应看到每个 TCP/UDP checksum 为 `correct` / `sum ok`，选项解码与下表一致，IPv6 包显示 `HBH (padn) DSTOPT (padn)`，`truncated.pcap` 报 `truncated dump file`。
- 新增 fixture：改 `tools/mkpcap.py` → 重跑 → 在 `index.zig` 的 `all` 里加一行 `@embedFile`。

规范：pcap `https://www.tcpdump.org/manpages/pcap-savefile.5.txt`、draft-ietf-opsawg-pcap；DLT_NULL `https://www.tcpdump.org/linktypes/LINKTYPE_NULL.html`；IPv4 RFC 791；IPv6 RFC 8200 §4；TCP RFC 9293（选项 §3.1，SACK-permitted RFC 2018，Timestamps / Window Scale RFC 7323）。

## 文件清单

| 文件 | 来源 `.bin` | linktype | 磁盘 magic | 字节序 / 精度 | 记录数 | 用途 |
|---|---|---|---|---|---|---|
| `chrome-153-macos-lo0-1seg.pcap` | `chrome-153-macos-1.bin`（1949 B） | 0 DLT_NULL | `d4c3b2a1` | little / µs | 3 | macOS lo0 形态：AF 头 `02000000`（小端 AF_INET），IPv4，SYN → SYN-ACK → 一个 PSH/ACK 装下整个 ClientHello record |
| `chrome-153-macos-en0-2seg.pcap` | `chrome-153-macos-2.bin`（1949 B） | 1 EN10MB | `d4c3b2a1` | little / µs | 8 | 以太网 + IPv4；ARP 与 UDP(DNS) 噪声帧（解析器应返回 `Unsupported`）；三次握手 + 纯 ACK；ClientHello 拆成 1400 + 549 两段，中间夹一个服务器纯 ACK；**第二段 seq 绕过 2^32**（ISN `0xfffffd00`）；服务器纯 ACK 无选项、54 字节帧被补零到 60，IP total length 必须把补零截掉 |
| `firefox-157b4-macos-v6-1seg.pcap` | `firefox-157b4-macos-1.bin`（1887 B） | 1 EN10MB | `d4c3b2a1` | little / µs | 3 | 以太网 + IPv6；数据包带扩展头链 IPv6 → Hop-by-Hop(0, 8 B) → Destination Options(60, 16 B) → TCP；单段（帧 1997 B 超过以太网 MTU，相当于 TSO 抓包） |
| `safari-26.6.2-macos-nano.pcap` | `safari-26.6.2-macos-1.bin`（1532 B） | 0 DLT_NULL | `a1b23c4d` | **big** / ns | 3 | 纳秒 magic；有意写成大端文件，于是 DLT_NULL 的 AF 头也是大端 `00000002`，覆盖"两种字节序都试"；`ts_frac` 带亚微秒位（如 124691365） |
| `syn-only.pcap` | — | 0 DLT_NULL | `d4c3b2a1` | little / µs | 1 | 只有一个 SYN：重组记录 SynInfo，但没有任何带 payload 的 flow，`firstClientPayload` 返回 `error.NoTlsPayload` |
| `truncated.pcap` | 同 lo0-1seg | 0 DLT_NULL | `d4c3b2a1` | little / µs | 2 完整 + 1 残缺 | lo0-1seg 在最后一条记录的数据中间截断（1206 B）：reader 读出 2 条后返回 `error.Truncated` |

说明：纳秒 magic `a1b23c4d` 在这里按**磁盘字节** `a1 b2 3c 4d` 写（即 spec/test-vectors.json 的 `magic_be_nsec`），所以 Safari 文件是大端。小端纳秒（磁盘 `4d3cb2a1`）与大端微秒由 `src/pcap.zig` 里读 `spec/test-vectors.json` 的内存用例覆盖。

## 每个文件的关键期望（完整值以 `*.expected.json` 为准）

地址：lo0 用 127.0.0.1；en0 用 RFC 5737 文档段 192.0.2.23（客户端）→ 192.0.2.10:8443；IPv6 用 RFC 3849 文档段 2001:db8::17 → 2001:db8::a。MAC 为本地管理地址 02:00:00:00:00:17 / 02:00:00:00:00:0a。服务器端口一律 8443。

客户端 SYN（所有文件同一形状，仿 macOS 顺序）：`MSS, NOP, WScale 6, NOP, NOP, Timestamps, SACK-permitted, EOL` + 1 字节补零 = 24 字节，data offset 11，window 65535，TTL / hop limit 64。TCP option iterator 应产出 kind 序列 `2,1,3,1,1,8,4,0`（在 EOL 处停，补零字节不访问）。

| 文件 | 客户端端口 | ISN | SYN MSS | SYN options hex | 服务器 SYN-ACK 选项 kinds / WScale | 客户端 payload |
|---|---|---|---|---|---|---|
| lo0-1seg | 54321 | 708529245 (`2a3b4c5d`) | 16344 | `02043fd8010303060101080a1a2b3c4d0000000004020000` | `2,1,3,4,8` / 7 | 1 段 1949 B |
| en0-2seg | 54322 | 4294966528 (`fffffd00`) | 1460 | `020405b4010303060101080a0badcafe0000000004020000` | `2,1,3,4,8` / 7（server TTL 57） | 1400 B（seq 4294966529）+ 549 B（seq 633） |
| v6-1seg | 54323 | 287454020 (`11223344`) | 1440 | `020405a0010303060101080a1a2b3c4d0000000004020000` | `2,1,3,4,8` / 7 | 1 段 1887 B |
| nano | 54324 | 253635900 (`0f1e2d3c`) | 16344 | `02043fd8010303060101080a1a2b3c4d0000000004020000` | `2,1,3,4,8` / 7 | 1 段 1532 B |
| syn-only | 54325 | 16909060 (`01020304`) | 16344 | `02043fd8010303060101080a0a0b0c0d0000000004020000` | — | 无 |

数据段的 TCP 选项为 `NOP, NOP, Timestamps`（12 字节，data offset 8）；en0 的服务器纯 ACK 无选项（data offset 5）。

重组后的客户端 payload 的 sha256 必须等于原 `.bin` 的 sha256：

| 文件 | sha256 |
|---|---|
| lo0-1seg / truncated 的来源 | `2943d5e061ede06bd67f207250a78e530f32af6d419a2b9edb1e5483bf0f24fb` |
| en0-2seg | `58fe41754d525ac1ff9d593a6e8212b7e53dfeab25fce73e85c415cc2a6c7df1` |
| v6-1seg | `2297a7d3cfe4bdefd21b7f00003ff434a7afd0def6f6b002fd56f0d898af0fb1` |
| nano | `536bb102899de3f174f2a1737830d4b3c1567471f32153f1a9cc53b12f3e37c9` |

## `*.expected.json` 结构

Zig 侧类型见 `index.zig` 的 `Expected`（`std.json.parseFromSlice(..., .{ .ignore_unknown_fields = true })`）。

- 顶层：`file_len`、`file_sha256`、`magic_bytes`（磁盘前 4 字节 hex）、`endian`（`little`/`big`）、`nanosecond`、`version_major`/`version_minor`（2/4）、`snaplen`（262144）、`linktype`、`record_count`（完整记录数）、`trailing_error`（读完完整记录后 reader 应返回的错误名，`null` 表示干净结束）、`records[]`、`client`。
- `records[i]`：`offset`（记录头在文件中的偏移）、`ts_sec`、`ts_frac`、`incl_len`、`orig_len`、`note`（人读）、`parse_error`（帧解析器应返回的错误名，如 ARP/UDP 为 `Unsupported`）、`packet`。
- `packet`：`ip_version`、`ip_ext_headers`（IPv6 扩展头类型链）、`link_header_len`（DLT_NULL 4 / 以太网 14）、`ip_len`（帧内 IP 包长度；其后是链路层补零）、`src_hex`/`dst_hex`（原始地址字节 hex）、`ttl`、`src_port`、`dst_port`、`seq`、`ack`、`data_offset`、`flags`（TCP flags 字节，FIN=bit0 … CWR=bit7）、`window`、`options_hex`、`option_kinds`（iterator 应产出的序列）、`mss`、`wscale`、`payload_len`。`src`/`dst`/`flag_names` 仅供人读。
- `client`：客户端四元组、`isn`、`syn`（window / ttl / options_hex / option_kinds / mss / wscale）、`payload_len`、`payload_sha256`（无 payload 时为 `null`）、`source_bin`、`source_sha256`。
