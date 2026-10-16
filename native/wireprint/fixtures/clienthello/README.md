# fixtures/clienthello

真实浏览器发出的第一个 TLS record（5 字节 record 头 + ClientHello 握手消息），以及 OpenSSL oracle 对它们的解析结果。

## 来源

`*.bin`：2026-09-23，一台 macOS 26.6.2 机器上的三个浏览器打一个独立的 OpenSSL PoC 服务器（localhost，自签证书），服务器在 accept 之后用 `MSG_PEEK` 读出的首个完整 record。全部是单 record、单 TCP segment。SNI 为 `localhost`；除浏览器版本外不含可识别信息（random、key_share、PSK identity 都是每连接的一次性值）。

| 文件 | 客户端 | 备注 |
|---|---|---|
| `chrome-153-macos-1.bin` / `-2.bin` | Chrome 153.0.8010.53 | 两次独立连接；扩展集合相同、顺序不同（Chrome 的扩展乱序） |
| `chrome-153-macos-psk.bin` | Chrome 153 | 会话恢复尝试：`pre_shared_key`（0x0029）是最后一个扩展 |
| `firefox-157b4-macos-1.bin` | Firefox Developer Edition 157.0 | 首连 |
| `firefox-157b4-macos-psk.bin` | Firefox DE 157.0 | 会话恢复 |
| `safari-26.6.2-macos-1.bin` | Safari 26.6.2 | 无 ECH（没有 0xfe0d） |

`cft-155-macos-*.bin`（0.4-W2 加入）：2026-10-16，macOS arm64 上的 Chrome for Testing 155.0.8059.79 打 0.4-W2 spike 的 Bun echo（`Bun.listen` 前端记录、再转发给 `node:tls`），前端收到的首个完整 record。启动参数是 spike 的最小参数，不是 tabcap 的生产参数（所以带 field trial 实验的扩展 `12e0`），只当解析与 diff 的测试输入，不当基准画像。SNI 为 `localhost`。

| 文件 | 那条连接 | 备注 |
|---|---|---|
| `cft-155-macos-nav-1.bin` / `-nav-2.bin` | 两次导航各自的首次连接 | 扩展集合相同、顺序不同；GREASE 值不同 |
| `cft-155-macos-psk.bin` | 恢复会话（`0029` 在最后），承载 `/favicon.ico` | |

三份的 `.expected.json` 同样是 `tools/openssl_oracle.c`（OpenSSL 3.6.4）的原样输出；重跑 oracle 时 `chrome-153-macos-1.expected.json` 逐字节不变（核对过）。

这些是"一台机器、一个时刻"的样本，数值以本项目正式采集（`corpus/`）为准，不代表该浏览器版本的全部行为。

## expected.json

`<name>.expected.json` 是 `tools/openssl_oracle.c` 对 `<name>.bin` 的**原样 stdout**，不要手改；要更新就重跑 oracle（命令见 `tools/README-oracle.md`）。字段说明也在那里。要点：

- `input_sha256` 绑定了输入文件；测试先核对它。
- `cipher_suites` 含 GREASE，线上顺序。
- `recognized_extension_order` / `recognized_extensions` **只含 OpenSSL 3.6.4 认识的扩展**；GREASE、`44cd`、`ca34`、`fe0d`、`001c`、`0022` 不在其中。`get0_ext_present_types` 证明 `SSL_client_hello_get0_ext` 也取不到这些未识别扩展。
- `record_header` 与 `handshake`（type / length / sha256）来自 OpenSSL 的 msg_callback，用于核对 record 层。

`index.zig` 把六份 JSON `@embedFile` 进 `fixtures` 模块（`clienthello_expected.all`），名字与 `../root.zig` 里的 `clienthello.all` 一一对应。

## 测试怎么用它们

`src/tls/record.zig` 与 `src/tls/client_hello.zig` 底部的测试：

1. 逐项相等：record 头、握手消息 sha256、legacy_version、random、session_id、cipher_suites、compression_methods、每个认识扩展的 `extension_data`。
2. 顺序：我们的扩展类型列表按 `get0_ext_present_types` 过滤后，必须**等于** `recognized_extension_order`（因此也是子序列）。
3. 结构：扩展块被精确铺满、与消息同时结束；`extension_count` 与迭代次数一致。
4. 样本事实（来自采集条件，不来自 oracle）：SNI 为 `localhost`，ALPN 为 `h2, http/1.1`，均提供 `0x0304` 与 X25519MLKEM768（`0x11ec`，key_exchange 1216 字节）；Chrome 有 `ca34`、`44cd`；Safari 没有 `fe0d`；两份 `-psk` 的最后一个扩展是 `0x0029`。
5. 构造输入：把真实消息重新切成多条 record、在 record 里追加第二条消息、逐字节截断、逐字节篡改，验证 `Truncated` / `Malformed` / 不 panic。
