# wireprint（`native/wireprint/`）

tabcap 的原生组件，线路层客户端指纹（Zig 0.16.0）：pcap → TCP 重组 → TLS ClientHello 全字段、JA3、JA4（`_r` / `_o` / `_ro`）；HTTP/2 的 SETTINGS / WINDOW_UPDATE / PRIORITY / 伪头顺序、HPACK 解码后的头与 Akamai 串；HTTP/1.1 请求头；对照画像的跨层一致性检查；按层分组的 diff。规范、oracle 与规则见 `docs/11`；代码规则见根目录 `AGENTS.md`「native/ 代码规则」。

- 测试（仓库根目录）：`bun run test:native`（即本目录 `zig build test`）；格式化：`bun run fmt:native`。
- 构建（本目录）：`zig build` → `zig-out/bin/wireprint {parse|ja3|ja4|h2|report|profile|check|diff|version}`；发布用 `-Doptimize=ReleaseSafe -Dstrip=true -Dtarget=<t>`，由 `bun scripts/native.ts build` 交叉编译四个目标到 `native/dist/<target>/`（git 忽略），tabcap 把它们嵌进自己的二进制。
- 纯 Zig，不链 libc 也不链 C 库。TLS 不在这里终结：tabcap 的 Bun echo（`src/wire/echo.ts`）终结 TLS，把原始 ClientHello 与解密后的 h2 / h1 字节交给 `wireprint report`（0.4-W2 起；OpenSSL 版 `serve` 已删除）。JA4H / JA4T 不实现（10-16 作者定，已删除）。
- 退出码：0 成功；1 用法或输入错误（`error: …` 一行在 stderr，stdout 为空）；3 `check` 判 INCONSISTENT（JSON 仍在 stdout）。
- 测试离线（`@embedFile` 嵌入 `fixtures/`、`spec/`）；`fixtures/pcap/` 是合成的（`tools/mkpcap.py`，文档地址段、本地管理 MAC）。`corpus/` 只收 tabcap 采集的 Chrome for Testing 画像。
