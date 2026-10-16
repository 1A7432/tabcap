# wireprint（`native/wireprint/`）

tabcap 的原生组件，线路层客户端指纹（Zig 0.16.0）：pcap → TCP 重组 → TLS ClientHello 全字段、JA3、JA4（`_r` / `_o` / `_ro`）；HTTP/2 的 SETTINGS / WINDOW_UPDATE / PRIORITY / 伪头顺序、HPACK 解码后的头与 Akamai 串；对照画像的跨层一致性检查；按层分组的 diff。规范、oracle 与规则见 `docs/11`；代码规则见根目录 `AGENTS.md`「native/ 代码规则」。

- 测试（仓库根目录）：`bun run test:native`（即本目录 `zig build test -Dopenssl=false`）；格式化：`bun run fmt:native`。
- 构建（本目录）：`zig build -Dopenssl=false` → `zig-out/bin/wireprint {parse|ja3|ja4|h2|profile|check|diff}`。
- tabcap 只构建 `-Dopenssl=false`：`serve` 子命令与 OpenSSL 链接留在源码里但不编译（TLS 终结改由 Bun 做，0.4-W2）。JA4H / JA4T 不实现（10-16 作者定，已删除）。
- 测试离线（`@embedFile` 嵌入 `fixtures/`、`spec/`）；`fixtures/pcap/` 是合成的（`tools/mkpcap.py`，文档地址段、本地管理 MAC）。`corpus/` 只收 tabcap 采集的 Chrome for Testing 画像。
