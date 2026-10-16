# openssl_oracle：ClientHello 的 OpenSSL oracle

`tools/openssl_oracle.c` 把一份原始 ClientHello record（`fixtures/clienthello/*.bin`）喂给 OpenSSL 的服务端状态机，把 OpenSSL **自己解析出来的字段**写成 JSON。`fixtures/clienthello/*.expected.json` 就是它的原样输出，ClientHello 解析器的测试以它为准——expected 值来自 OpenSSL，不来自本项目的解析器。

## 原理

1. `SSL_CTX_new(TLS_server_method())` + `SSL_new`，`SSL_set_bio` 挂两个 `BIO_s_mem`：rbio 装"客户端发来的字节"，wbio 接服务端的回应（丢弃）。
2. 把整个 `.bin`（5 字节 record 头 + ClientHello 握手消息，也可以是多条 record）`BIO_write` 进 rbio，然后 `SSL_accept`。
3. 两个回调旁观 OpenSSL 的解析：
   - `SSL_set_msg_callback`：`SSL3_RT_HEADER` 给出 record 层读到的第一个 5 字节 record 头；`SSL3_RT_HANDSHAKE` 给出重组后的完整握手消息（含 4 字节握手头）——工具只记录它的 type、length 与 SHA-256。
   - `SSL_CTX_set_client_hello_cb`：用 `SSL_client_hello_get0_*` 读字段并输出 JSON，然后返回 `SSL_CLIENT_HELLO_ERROR` 终止握手（所以不需要证书和私钥，也不会发出任何东西）。

## 编译

需要 Homebrew 的 OpenSSL 3.6（keg-only，路径要显式给）和 Zig 0.16 自带的 `zig cc`：

```sh
mkdir -p /tmp/wireprint-oracle
zig cc -std=c11 -Wall -Wextra -O2 \
  -I/opt/homebrew/opt/openssl@3/include \
  -L/opt/homebrew/opt/openssl@3/lib -lssl -lcrypto \
  tools/openssl_oracle.c -o /tmp/wireprint-oracle/openssl_oracle
```

## 运行（重新生成 expected.json）

在仓库根目录：

```sh
for f in fixtures/clienthello/*.bin; do
  n=$(basename "$f" .bin)
  /tmp/wireprint-oracle/openssl_oracle "$f" > "fixtures/clienthello/$n.expected.json" || echo "FAIL $n"
done
zig build test --summary all
```

输出是确定性的（没有时间戳），同一个 OpenSSL 版本重跑应当逐字节相同：

```sh
for f in fixtures/clienthello/*.bin; do
  n=$(basename "$f" .bin)
  /tmp/wireprint-oracle/openssl_oracle "$f" | cmp - "fixtures/clienthello/$n.expected.json" && echo "same $n"
done
```

退出码：回调运行过为 0；否则为 1，并把 OpenSSL 错误队列打到 stderr（例如 `tls_process_client_hello:length too short`）。

## JSON 字段

| 字段 | 来源 | 说明 |
|---|---|---|
| `fixture` | 文件名 | 去掉 `.bin` 的 basename，对应 `fixtures/root.zig` 里 `clienthello.all[].name` |
| `input_length` / `input_sha256` | 输入文件 | 测试先核对 sha256，保证这份 expected 属于这份 `.bin` |
| `oracle` / `oracle_version` | `OpenSSL_version(OPENSSL_VERSION)` | 本次生成用的是 `OpenSSL 3.6.4 25 Aug 2026` |
| `record_header` | msg_callback `SSL3_RT_HEADER` | 第一个 record 头：`content_type`（十进制）、`legacy_version`（4 位 hex）、`length` |
| `handshake` | msg_callback `SSL3_RT_HANDSHAKE` | 第一条握手消息：`msg_type`、`length`（uint24 字段的值，即 body 长度）、整条消息（含 4 字节头）的 `sha256` |
| `isv2` | `SSL_client_hello_isv2` | SSLv2 兼容格式；浏览器样本全是 `false` |
| `legacy_version` | `get0_legacy_version` | 4 位 hex |
| `random` / `session_id` | `get0_random` / `get0_session_id` | 原始字节 hex |
| `cipher_suites` | `get0_ciphers` | 原始字节按 2 字节切开，**含 GREASE**，线上顺序 |
| `compression_methods` | `get0_compression_methods` | 原始字节 hex |
| `recognized_extension_order` | `SSL_client_hello_get_extension_order` | **只含 OpenSSL 认识的扩展**，线上相对顺序 |
| `recognized_extensions` | `SSL_client_hello_get0_ext(type)` | 每个认识的扩展的 `extension_data`（不含 2 字节 type 和 2 字节 length），hex |
| `get0_ext_present_types` | 对 0x0000–0xffff 逐个调 `get0_ext` | `get0_ext` 能回答的全部类型（升序） |

## 局限（读测试时要记住）

- man 页原文："unrecognised (including GREASE) extensions will not appear in the output"。所以 GREASE、ALPS 新码点 `44cd`、ECH `fe0d`、trust_anchors `ca34`、Firefox 的 record_size_limit `001c` 与 delegated_credentials `0022` 都不在 `recognized_extension_order` 里。
- `SSL_client_hello_get0_ext` **同样看不到未识别的扩展**：`get0_ext_present_types` 在 6 份样本上都恰好等于 `recognized_extension_order` 的集合（"可以按类型取任一扩展的原始字节（包括未识别类型）"在 OpenSSL 3.6.4 上不成立）。
- 因此**完整的扩展顺序没有 oracle**：测试只能核对 (a) 认识的扩展在我们的列表里出现的顺序与 OpenSSL 完全一致；(b) 扩展块被 type/length/data 精确铺满、与消息同时结束；(c) 整条握手消息的 SHA-256 与 OpenSSL 重组的一致。要核对未识别扩展的位置，需要 Wireshark 或 FoxIO 参考实现作为第二 oracle。
- 源码旁证（OpenSSL 3.3.2 源码；3.6.4 的行为与之一致，见上一条的探测结果）：`ssl/ssl_lib.c` 的 `SSL_client_hello_get0_ext` 只遍历 `clienthello->pre_proc_exts`，而 `ssl/statem/extensions.c` 的 `tls_collect_extensions` 只把认识的扩展放进这个数组。
- 同一个函数"只对认识的扩展检查重复"（源码注释原文 "We only check duplicates for extensions that we recognise"），并且在回调**之前**就拒绝 `pre_shared_key` 不在最后的 ClientHello。本项目的解析器按 RFC 8446 §4.2 / RFC 9846 §4.3 对**所有**类型检查重复，但不强制 PSK 在最后（留给检查层当作异常特征记录）。所以"PSK 不在最后"的输入无法用这个 oracle 生成 expected。
- 多 record 输入也能喂：把一份样本拆成 3 条 record（3 / 697 / 其余字节）后，OpenSSL 报告的 `handshake.sha256` 与单 record 版本相同——这是 `firstHandshakeMessage` 跨 record 拼接逻辑的旁证。
